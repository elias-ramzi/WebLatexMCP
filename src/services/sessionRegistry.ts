import path from 'node:path';
import { mkdir, readdir, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { sessionDir, sessionStateDir } from '../lib/sessionPaths.js';

/** One session's advertisement of itself, as written to disk. */
export interface SessionRecord {
  sessionId: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
}

/** A session as seen by a peer, with liveness resolved. */
export interface PeerSession extends SessionRecord {
  /** False once the owning process is gone, or it stopped heartbeating long ago. */
  live: boolean;
  /** True for the session doing the asking. */
  self: boolean;
}

/** Heartbeat older than this, with no visible process, means the session is gone. */
const STALE_MS = 30 * 60 * 1000;
/** Don't rewrite the record more often than this — a heartbeat costs a disk write. */
const HEARTBEAT_THROTTLE_MS = 30_000;

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Lets the agent sessions sharing a workspace see each other.
 *
 * Each session advertises itself in its own file, so no two processes ever write the same one and
 * the registry needs no lock of its own. A session that crashes cannot retract its record, so
 * liveness is derived rather than trusted: the owning pid must still exist, or the heartbeat must
 * be recent.
 *
 * This is deliberately advisory. It exists so `status` can say who else is working and so
 * abandoned state can be cleaned up — nothing here grants or withholds access to anything, and a
 * missing or stale registry only ever costs visibility.
 */
export class SessionRegistry {
  private readonly lastHeartbeat = new Map<string, number>();

  constructor(
    private readonly workspaceRoot: string,
    readonly sessionId: string,
  ) {}

  /** Record this session as working on `projectId`, throttled to one write per interval. */
  async touch(projectId: string): Promise<void> {
    const last = this.lastHeartbeat.get(projectId);
    const now = Date.now();
    if (last !== undefined && now - last < HEARTBEAT_THROTTLE_MS) return;
    this.lastHeartbeat.set(projectId, now);

    const dir = sessionDir(this.workspaceRoot, projectId, this.sessionId);
    await mkdir(dir, { recursive: true });
    const existing = await this.readRecord(dir);
    const record: SessionRecord = {
      sessionId: this.sessionId,
      pid: process.pid,
      startedAt: existing?.startedAt ?? new Date(now).toISOString(),
      heartbeatAt: new Date(now).toISOString(),
    };
    await writeAtomic(path.join(dir, 'session.json'), JSON.stringify(record, null, 2));
  }

  /** Every session known to have worked on `projectId`, most recently seen first. */
  async peers(projectId: string): Promise<PeerSession[]> {
    const root = sessionStateDir(this.workspaceRoot, projectId);
    let entries: string[];
    try {
      entries = (await readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return []; // nothing has run against this project yet
    }
    const found = await Promise.all(
      entries.map(async (id) => {
        const record = await this.readRecord(path.join(root, id));
        if (!record) return null;
        const age = Date.now() - Date.parse(record.heartbeatAt);
        const self = record.sessionId === this.sessionId;
        return {
          ...record,
          self,
          live: self || pidAlive(record.pid) || (Number.isFinite(age) && age < STALE_MS),
        } satisfies PeerSession;
      }),
    );
    return found
      .filter((p): p is PeerSession => p !== null)
      .sort((a, b) => Date.parse(b.heartbeatAt) - Date.parse(a.heartbeatAt));
  }

  /** Sessions other than this one that are still alive. */
  async livePeers(projectId: string): Promise<PeerSession[]> {
    return (await this.peers(projectId)).filter((p) => !p.self && p.live);
  }

  /**
   * Delete the state of sessions that are demonstrably gone, and return their ids.
   *
   * A dead session's edits stay in the working tree — only the record of *whose* they were is
   * dropped, which shows up as unattributed changes rather than as data loss.
   */
  async collectGarbage(projectId: string): Promise<string[]> {
    const dead = (await this.peers(projectId)).filter((p) => !p.self && !p.live);
    await Promise.all(
      dead.map((p) =>
        rm(sessionDir(this.workspaceRoot, projectId, p.sessionId), {
          recursive: true,
          force: true,
        }),
      ),
    );
    return dead.map((p) => p.sessionId);
  }

  /** Remove this session's record — best-effort, on clean shutdown. */
  async release(projectId: string): Promise<void> {
    await rm(path.join(sessionDir(this.workspaceRoot, projectId, this.sessionId), 'session.json'), {
      force: true,
    });
  }

  /** Projects this session has state for, so shutdown can release all of them. */
  trackedProjects(): string[] {
    return [...this.lastHeartbeat.keys()];
  }

  private async readRecord(dir: string): Promise<SessionRecord | null> {
    try {
      return JSON.parse(await readFile(path.join(dir, 'session.json'), 'utf8')) as SessionRecord;
    } catch {
      return null;
    }
  }
}

/** Write via a temp file + rename, so a reader never sees a half-written record. */
export async function writeAtomic(target: string, content: string): Promise<void> {
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, target);
}
