import path from 'node:path';
import { mkdir, readdir, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { sessionDir, sessionStateDir } from '../lib/sessionPaths.js';
import {
  currentBootStamp,
  isSameBoot,
  withinLegacyPidGrace,
  writtenSinceProcessStart,
} from '../lib/bootIdentity.js';

/** One session's advertisement of itself, as written to disk. */
export interface SessionRecord {
  sessionId: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  /** Approximate instant the machine booted, stamped when the record was written. */
  bootedAt?: string;
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
 * `currentBootStamp()`, degraded to `undefined` on failure instead of throwing — see the callers'
 * comments for why a failure here must never propagate.
 */
function readBootStamp(): string | undefined {
  try {
    return currentBootStamp();
  } catch {
    return undefined;
  }
}

/**
 * Lets the agent sessions sharing a workspace see each other.
 *
 * Each session advertises itself in its own file, so no two processes ever write the same one and
 * the registry needs no lock of its own. A session that crashes cannot retract its record, so
 * liveness is derived rather than trusted: the owning pid must still exist **and belong to the
 * same boot that recorded it**, or the heartbeat must be recent.
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
      // Stamped fresh on every write, never carried forward from `existing` the way `startedAt`
      // is: `startedAt` describes the session and stays true for its whole life, but a process
      // cannot outlive the boot that started it, so the current boot is always the right answer.
      // Carrying a stale one forward would fail in the **fail-open** direction — not the ghost
      // direction: a stamp naming a previous boot makes `isSameBoot` return false for a session
      // that is genuinely running right now, so a live peer reads dead, `status` collapses it into
      // `staleSessions`, and `push` / `commit scope: "paths"` are free to sweep its uncommitted
      // lines. It could not reintroduce the ghost (a ghost is a *dead* session reading live, and a
      // stale stamp only ever revokes a grant), which is precisely why it is the worse of the two:
      // re-stamping is not an optimisation to fold away.
      //
      // `currentBootStamp()` calls `os.uptime()`, which can throw (libuv returns an error on
      // Linux when neither `/proc/uptime` nor `CLOCK_BOOTTIME` is available — a containerised
      // case libuv itself calls out). This registry is advisory: a missing or stale registry only
      // ever costs visibility, so a heartbeat must never fail just because the boot stamp
      // couldn't be read. Write the record with `bootedAt` simply absent rather than failing the
      // write — such a record earns no stamp route, but a peer whose own process started before
      // this heartbeat still grants it the pid clause via `writtenSinceProcessStart`, and failing
      // that it falls back to the bounded heartbeat-liveness clause below.
      bootedAt: readBootStamp(),
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
    // Read once per call, not once per peer: it's a syscall, and every peer judged in this call
    // must be judged against the same reading. `os.uptime()` can throw (see `readBootStamp`); when
    // it does, the stamp comparison cannot be made for *any* peer this call, so fall back to the
    // pre-boot-scoping behaviour for the pid clause — `pidAlive` alone — rather than letting the
    // throw propagate out of `peers()` → `livePeers()` → `guardPeerWork` and hard-fail `status`,
    // `commit` and `push`. That fallback is the module's stated fail-closed bias: it can only grant
    // a spurious `live` (as it always did before this field existed), never sweep a live peer's
    // work out from under it.
    let boot: string | null;
    try {
      boot = currentBootStamp();
    } catch {
      boot = null;
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
          // Three ways to be live:
          //  - it's us: always live.
          //  - the recorded pid is running AND (belongs to the same boot that recorded it, OR its
          //    heartbeat was written since this very process started). This used to be
          //    `pidAlive(record.pid)` alone, with no time bound at all — after a reboot on a
          //    persisted workspace, a dead session's recorded pid can belong to an unrelated live
          //    process, so `pidAlive` returned true forever, `live` never went false, `status`
          //    never collapsed the record into `staleSessions`, and `guardPeerWork`
          //    (src/lib/peerRefusal.ts) refused every push against a dirty tree with no way to
          //    clear it but deleting the session file by hand. Boot-scoping is what makes this
          //    path bounded again: it can only be true while the process genuinely still exists.
          //
          //    The `isSameBoot` half is a *derived* stamp (`Date.now() - os.uptime()*1000`) and
          //    drifts whenever the wall clock is stepped without uptime advancing (VM pause, host
          //    timesync, a laptop resuming from sleep) — measured to consume ~90% of
          //    `BOOT_STAMP_TOLERANCE_MS` on one real machine. Left as the only route, that drift
          //    made a genuinely live peer with a merely-stale heartbeat read as dead (both clauses
          //    die together), letting `commit scope: "paths"` take its uncommitted lines — a
          //    regression in the fail-open direction this whole module exists to avoid.
          //    `writtenSinceProcessStart` is a second, drift-immune route to the same grant: this
          //    process has been running continuously since it started, so a heartbeat written
          //    since then was necessarily written during *our* boot, no derived stamp needed. It
          //    also rescues a still-running *legacy* session with no `bootedAt` at all (Node does
          //    not hot-reload, so an old-build process heartbeating right now can never write the
          //    field) — such a record used to get no pid grant whatsoever and fell through to the
          //    bounded heartbeat clause alone, stranding it once idle past `STALE_MS`. That rescue
          //    reaches only as far as the peer goes on heartbeating after *this* process started,
          //    which is why `withinLegacyPidGrace` exists beside it: a stampless record carries no
          //    evidence either way (unlike a stamp naming another boot, which is evidence
          //    against), so it keeps the pid grant on the pid alone — but for a bounded 24h, not
          //    forever, which is the whole difference from the unbounded clause this module was
          //    written to fix. Without it, an old-build session idle past `STALE_MS` read dead,
          //    its peer's `guardPeerWork` saw nobody live, and a `push` with a `message`
          //    (`git add -A`) or a `commit scope: "paths"` took its uncommitted lines. When `boot`
          //    itself is unreadable (`null`, see above) the stamp route is skipped entirely and
          //    the pid clause grants on `pidAlive` alone, same as pre-boot-scoping.
          //  - the heartbeat is recent (bounded grace of STALE_MS), untouched by boot-scoping —
          //    the fallback once neither pid route grants: a genuinely dead pid, or a live one that
          //    hasn't heartbeated since a boot the stamp can't vouch for.
          //
          // Residual, stated rather than overclaimed: pid reuse *within* a single boot (pid
          // wraparound) is still not detected — that needs the OS's per-process start time, which
          // has no portable source across Linux/macOS/Windows. And if *this* process itself started
          // after a clock step, while a peer has been alive since before it and hasn't heartbeated
          // since, neither route vouches for that peer (see `writtenSinceProcessStart`'s doc) —
          // that peer has a stamp, so the legacy grace does not reach it either. A stampless
          // session idle for longer than `LEGACY_PID_GRACE_MS` still reads dead as well; bounded
          // is the point, so that one is a deliberate expiry rather than an oversight.
          live:
            self ||
            (pidAlive(record.pid) &&
              (boot === null ||
                isSameBoot(record.bootedAt, boot) ||
                writtenSinceProcessStart(record.heartbeatAt) ||
                withinLegacyPidGrace(record.bootedAt, age))) ||
            (Number.isFinite(age) && age < STALE_MS),
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
