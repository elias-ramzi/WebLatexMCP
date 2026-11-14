import { readFile } from 'node:fs/promises';
import { callLogPath, type CallRecord } from './callLog.js';

/**
 * `web-latex-mcp call-stats`: a summary of the tool-call log (`src/lib/callLog.ts`) aimed at the
 * three questions it is kept for —
 *
 * - **tokens**: which tools return the most text, per call and in total;
 * - **speed**: which are slow, and whether the time is their own or spent waiting (project lock,
 *   compile queue) or in a heavy step (TeX, pdf.js, the git remote);
 * - **missing tools**: tools called many times in a row, and pairs called back to back, which a
 *   batched or combined tool could replace.
 *
 * Pure apart from {@link readCallLog}, so the summary is unit-tested on canned records.
 */

/** Two calls of one session further apart than this are not a "pair". */
export const PAIR_GAP_MS = 120_000;
/** A run of one tool this long or longer, in one session, is reported. */
export const MIN_RUN = 3;

export interface ToolStats {
  tool: string;
  calls: number;
  errors: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  totalMs: number;
  meanTokens: number;
  totalTokens: number;
  maxTokens: number;
  images: number;
  meanLockWaitMs: number;
  meanGateWaitMs: number;
  /** Mean ms per call in each phase, over the calls that had it. */
  phases: Record<string, number>;
}

export interface CallStats {
  calls: number;
  sessions: number;
  from?: string;
  to?: string;
  tools: ToolStats[];
  pairs: Array<{ from: string; to: string; count: number }>;
  runs: Array<{ tool: string; runs: number; longest: number; calls: number }>;
  slowest: Array<{ tool: string; ts: string; ms: number; lockWaitMs: number; gateWaitMs: number }>;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)] as number;
}

const mean = (total: number, n: number): number => (n === 0 ? 0 : Math.round(total / n));

export function summarizeCalls(records: readonly CallRecord[], top = 15): CallStats {
  const sorted = [...records].sort((a, b) => a.ts.localeCompare(b.ts));
  const byTool = new Map<string, CallRecord[]>();
  for (const r of sorted) {
    const list = byTool.get(r.tool);
    if (list) list.push(r);
    else byTool.set(r.tool, [r]);
  }

  const tools: ToolStats[] = [...byTool].map(([tool, rs]) => {
    const ms = rs.map((r) => r.ms).sort((a, b) => a - b);
    const tokens = rs.map((r) => r.estTokens ?? 0);
    const totalTokens = tokens.reduce((a, b) => a + b, 0);
    const phaseTotals = new Map<string, { ms: number; n: number }>();
    for (const r of rs) {
      for (const [name, v] of Object.entries(r.phases ?? {})) {
        const p = phaseTotals.get(name) ?? { ms: 0, n: 0 };
        p.ms += v;
        p.n++;
        phaseTotals.set(name, p);
      }
    }
    return {
      tool,
      calls: rs.length,
      errors: rs.filter((r) => r.error).length,
      p50Ms: percentile(ms, 50),
      p95Ms: percentile(ms, 95),
      maxMs: ms[ms.length - 1] ?? 0,
      totalMs: ms.reduce((a, b) => a + b, 0),
      meanTokens: mean(totalTokens, rs.length),
      totalTokens,
      maxTokens: Math.max(0, ...tokens),
      images: rs.reduce((a, r) => a + (r.images ?? 0), 0),
      meanLockWaitMs: mean(
        rs.reduce((a, r) => a + (r.lockWaitMs ?? 0), 0),
        rs.length,
      ),
      meanGateWaitMs: mean(
        rs.reduce((a, r) => a + (r.gateWaitMs ?? 0), 0),
        rs.length,
      ),
      phases: Object.fromEntries([...phaseTotals].map(([k, v]) => [k, mean(v.ms, v.n)])),
    };
  });
  tools.sort((a, b) => b.totalTokens - a.totalTokens || b.totalMs - a.totalMs);

  // Pairs and runs are judged within one session, in call order.
  const bySession = new Map<string, CallRecord[]>();
  for (const r of sorted) {
    const list = bySession.get(r.session);
    if (list) list.push(r);
    else bySession.set(r.session, [r]);
  }
  const pairCounts = new Map<string, number>();
  const runStats = new Map<string, { runs: number; longest: number; calls: number }>();
  for (const rs of bySession.values()) {
    let runTool: string | undefined;
    let runLength = 0;
    const closeRun = (): void => {
      if (runTool !== undefined && runLength >= MIN_RUN) {
        const s = runStats.get(runTool) ?? { runs: 0, longest: 0, calls: 0 };
        s.runs++;
        s.longest = Math.max(s.longest, runLength);
        s.calls += runLength;
        runStats.set(runTool, s);
      }
    };
    for (let i = 0; i < rs.length; i++) {
      const r = rs[i] as CallRecord;
      const prev = rs[i - 1];
      if (prev && r.tool !== prev.tool) {
        const gap = Date.parse(r.ts) - (Date.parse(prev.ts) + prev.ms);
        if (gap <= PAIR_GAP_MS) {
          const key = `${prev.tool}\u0000${r.tool}`;
          pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
        }
      }
      if (r.tool === runTool) runLength++;
      else {
        closeRun();
        runTool = r.tool;
        runLength = 1;
      }
    }
    closeRun();
  }
  const pairs = [...pairCounts]
    .map(([key, count]) => {
      const [from, to] = key.split('\u0000') as [string, string];
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, top);
  const runs = [...runStats]
    .map(([tool, s]) => ({ tool, ...s }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, top);
  const slowest = [...sorted]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, top)
    .map((r) => ({
      tool: r.tool,
      ts: r.ts,
      ms: r.ms,
      lockWaitMs: r.lockWaitMs ?? 0,
      gateWaitMs: r.gateWaitMs ?? 0,
    }));

  return {
    calls: sorted.length,
    sessions: bySession.size,
    ...(sorted.length > 0 ? { from: sorted[0]?.ts, to: sorted[sorted.length - 1]?.ts } : {}),
    tools,
    pairs,
    runs,
    slowest,
  };
}

function pad(value: string | number, width: number, left = false): string {
  const s = String(value);
  return left ? s.padEnd(width) : s.padStart(width);
}

const secs = (ms: number): string => (ms >= 10_000 ? `${(ms / 1000).toFixed(0)}s` : `${ms}ms`);

export function renderCallStats(stats: CallStats): string {
  if (stats.calls === 0) return 'No tool calls logged yet.\n';
  const lines: string[] = [];
  lines.push(
    `${stats.calls} tool calls from ${stats.sessions} session(s), ${stats.from} to ${stats.to}.`,
    '',
    'Per tool, by total tokens returned (tokens ≈ result text / 4; images not counted):',
  );
  const w = Math.max(4, ...stats.tools.map((t) => t.tool.length));
  lines.push(
    `  ${pad('tool', w, true)} ${pad('calls', 6)} ${pad('err', 4)} ${pad('p50', 7)} ${pad('p95', 7)} ` +
      `${pad('max', 7)} ${pad('tok/call', 9)} ${pad('tok max', 8)} ${pad('tok total', 10)} ` +
      `${pad('lock', 6)} ${pad('queue', 6)}  phases (mean)`,
  );
  for (const t of stats.tools) {
    const phases = Object.entries(t.phases)
      .map(([k, v]) => `${k} ${secs(v)}`)
      .join(', ');
    lines.push(
      `  ${pad(t.tool, w, true)} ${pad(t.calls, 6)} ${pad(t.errors, 4)} ${pad(secs(t.p50Ms), 7)} ` +
        `${pad(secs(t.p95Ms), 7)} ${pad(secs(t.maxMs), 7)} ${pad(t.meanTokens, 9)} ` +
        `${pad(t.maxTokens, 8)} ${pad(t.totalTokens, 10)} ${pad(secs(t.meanLockWaitMs), 6)} ` +
        `${pad(secs(t.meanGateWaitMs), 6)}  ${phases}${t.images ? `  [${t.images} images]` : ''}`,
    );
  }
  if (stats.runs.length > 0) {
    lines.push('', `Runs of one tool (${MIN_RUN}+ in a row in one session) — batching candidates:`);
    for (const r of stats.runs) {
      lines.push(
        `  ${pad(r.tool, w, true)} ${r.runs} run(s), ${r.calls} calls, longest ${r.longest}`,
      );
    }
  }
  if (stats.pairs.length > 0) {
    lines.push('', 'Back-to-back pairs (same session, within 2 min) — combined-tool candidates:');
    for (const p of stats.pairs) lines.push(`  ${pad(p.count, 5)}  ${p.from} → ${p.to}`);
  }
  lines.push('', 'Slowest calls:');
  for (const s of stats.slowest) {
    const waits = [
      s.lockWaitMs ? `lock ${secs(s.lockWaitMs)}` : '',
      s.gateWaitMs ? `queue ${secs(s.gateWaitMs)}` : '',
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(`  ${pad(secs(s.ms), 7)}  ${s.tool}  ${s.ts}${waits ? `  (waited: ${waits})` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The log's records (the rotated `.1` first, then the current file) since `sinceMs`. A line that
 * does not parse, or is not a version-1 record, is skipped — a line cut by a crash, or a later
 * format.
 */
export async function readCallLog(workspaceRoot: string, sinceMs = 0): Promise<CallRecord[]> {
  const file = callLogPath(workspaceRoot);
  const out: CallRecord[] = [];
  for (const f of [`${file}.1`, file]) {
    let text: string;
    try {
      text = await readFile(f, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as CallRecord;
        if (r?.v !== 1 || typeof r.tool !== 'string' || typeof r.ts !== 'string') continue;
        if (Date.parse(r.ts) >= sinceMs) out.push(r);
      } catch {
        /* skip */
      }
    }
  }
  return out;
}
