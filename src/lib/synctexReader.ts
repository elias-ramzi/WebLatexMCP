/**
 * An in-process reader for `<job>.synctex.gz`, so a viewer click maps back to `file:line` on a
 * machine without TeX Live's `synctex` binary — a tectonic-only install, where the CLI the
 * server otherwise shells out to does not exist.
 *
 * The file is gzipped text in SyncTeX's documented format: a header (`Input:<tag>:<path>`,
 * `Unit:`, `Magnification:`, `X Offset:`, `Y Offset:`), then per page `{<n>` … `}<n>` holding box
 * records — `[`/`]` a vbox, `(`/`)` an hbox, `v`/`h` a void box, and the leaves `x` (current
 * point), `k` (kern), `g` (glue), `$` (math) — each `<tag>,<line>[,<column>]:<h>,<v>` followed, for
 * a box, by `:<W>,<H>,<D>`. Positions are in TeX scaled points from the page's top-left corner,
 * `v` downwards to the baseline; a box spans `[v-H, v+D]` vertically and `[h, h+W]` across.
 *
 * The query mirrors what `synctex edit` does closely enough for a comment anchor — it is not a
 * port of it: take the smallest hbox on the page containing the point (a line of text), and
 * within it the last leaf at or before the point's x (the run of text the click fell in); with
 * no hbox under the point, the nearest leaf on the page. The CLI stays the first choice whenever
 * it is installed (`SyncTexService.resolve`); this is the fallback.
 *
 * The file is written by the document's own compile, so its paths are untrusted like every other
 * synctex answer: the caller normalises them onto the project (`normalizeInput`) and `list_comments`
 * withholds one that leaves it.
 */

/** TeX scaled points per PostScript (PDF) point: 65536 sp/pt × 72.27 pt/in ÷ 72 bp/in. */
const SP_PER_BP = 65781.76;

export interface SyncTexHit {
  /** The `Input:` path exactly as the file records it. */
  input: string;
  line: number;
}

interface Box {
  tag: number;
  line: number;
  h: number;
  v: number;
  w: number;
  ht: number;
  dp: number;
  leaves: Leaf[];
}

interface Leaf {
  tag: number;
  line: number;
  h: number;
  v: number;
}

const RECORD =
  /^([[(vhxkg$])(\d+),(\d+)(?:,-?\d+)?:(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?/;

/**
 * Resolve a point on 1-based `page`, `x`/`y` in PDF points from the page's top-left, against the
 * text of a synctex file. `null` when the page is absent or nothing on it carries a line.
 */
export function synctexEditQuery(
  text: string,
  page: number,
  x: number,
  y: number,
): SyncTexHit | null {
  const inputs = new Map<number, string>();
  let unit = 1;
  let mag = 1000;
  let xOff = 0;
  let yOff = 0;

  const lines = text.split(/\r?\n/);
  let i = 0;
  // Header (and any `Input:` line anywhere: engines may declare inputs after `Content:`).
  const header = (l: string): boolean => {
    const input = /^Input:(\d+):(.*)$/.exec(l);
    if (input) {
      if (input[2]) inputs.set(Number(input[1]), input[2]);
      return true;
    }
    const kv = /^(Unit|Magnification|X Offset|Y Offset):(-?[\d.]+)$/.exec(l);
    if (kv) {
      const n = Number(kv[2]);
      if (kv[1] === 'Unit') unit = n || 1;
      else if (kv[1] === 'Magnification') mag = n || 1000;
      else if (kv[1] === 'X Offset') xOff = n;
      else yOff = n;
      return true;
    }
    return false;
  };

  // Find the page.
  const open = `{${page}`;
  for (; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (l === open) break;
    header(l);
  }
  if (i >= lines.length) return null;

  // The point, in the file's own units.
  const scale = (unit * mag) / 1000 / SP_PER_BP;
  const px = (x - xOff / SP_PER_BP) / scale;
  const py = (y - yOff / SP_PER_BP) / scale;

  const hboxes: Box[] = [];
  const allLeaves: Leaf[] = [];
  const stack: Box[] = [];
  for (i++; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (l === `}${page}`) break;
    if (l === ')' || l === ']') {
      stack.pop();
      continue;
    }
    if (header(l)) continue;
    const m = RECORD.exec(l);
    if (!m) continue;
    const kind = m[1];
    const tag = Number(m[2]);
    const line = Number(m[3]);
    const h = Number(m[4]);
    const v = Number(m[5]);
    if (kind === '(' || kind === '[') {
      const box: Box = {
        tag,
        line,
        h,
        v,
        w: Number(m[6] ?? 0),
        ht: Number(m[7] ?? 0),
        dp: Number(m[8] ?? 0),
        leaves: [],
      };
      if (kind === '(') hboxes.push(box);
      stack.push(box);
      continue;
    }
    // `v`/`h` void boxes and the leaves all anchor a position.
    const leaf: Leaf = { tag, line, h, v };
    allLeaves.push(leaf);
    const parent = stack[stack.length - 1];
    if (parent) parent.leaves.push(leaf);
  }

  const located = (r: { tag: number; line: number }): SyncTexHit | null => {
    const input = inputs.get(r.tag);
    return input !== undefined && r.line > 0 ? { input, line: r.line } : null;
  };

  // The smallest hbox containing the point: one output line, or a word box inside it.
  let best: Box | undefined;
  for (const b of hboxes) {
    if (px < b.h || px > b.h + b.w || py < b.v - b.ht || py > b.v + b.dp) continue;
    if (!best || b.w * (b.ht + b.dp) < best.w * (best.ht + best.dp)) best = b;
  }
  if (best) {
    const leaves = best.leaves.filter((f) => located(f));
    let pick: Leaf | undefined;
    for (const f of leaves) if (f.h <= px && (!pick || f.h >= pick.h)) pick = f;
    pick ??= leaves[0];
    const hit = pick ? located(pick) : located(best);
    if (hit) return hit;
  }

  // Nothing under the point: the nearest leaf on the page.
  let near: Leaf | undefined;
  let nearD = Infinity;
  for (const f of allLeaves) {
    if (!located(f)) continue;
    const d = (f.h - px) ** 2 + (f.v - py) ** 2;
    if (d < nearD) {
      nearD = d;
      near = f;
    }
  }
  return near ? located(near) : null;
}
