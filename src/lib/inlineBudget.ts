/**
 * Deciding which rendered pages may be inlined as MCP image content, against a byte budget on
 * the *wire* payload. Pulled out of `src/tools/renderPages.ts` so it is unit-testable without a
 * live MCP client: the tool layer only maps this plan onto response shapes.
 */

/** A budget on the base64-encoded payload MCP actually puts on the wire, not the raw PNG bytes:
 * base64 inflates by 4/3, so budgeting the raw size would let a call land at ~4/3 of this on the
 * wire. */
export const DEFAULT_INLINE_BUDGET_BYTES = 5 * 1024 * 1024;

/** What one page costs and whether it may be inlined. */
export interface InlineCandidate {
  page: number;
  bytes: number;
}

export interface InlinePlan {
  /** Parallel to the input: whether each page's image is inlined. */
  inlined: boolean[];
  /** Human-readable explanation when something was not inlined; undefined when all were. */
  note?: string;
}

/** Size of `bytes` once base64-encoded — the size that actually lands on the JSON-RPC wire. */
function encodedSize(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/**
 * Walk `candidates` in the given order accumulating encoded cost against `budgetBytes`. The first
 * page that would push the running total over budget is not inlined — and neither is any later
 * page, even one that would fit on its own. This sticky-prefix rule is intentional: a hole in the
 * middle of the page range ("pages 1, 2, 4 are pictures but 3 is not") is harder for a caller to
 * explain or reason about than a cut-off tail ("pages 1-2 are pictures, the rest are paths-only").
 * Every candidate still gets an entry in `inlined`; only the image content is affected.
 */
export function planInlining(
  candidates: InlineCandidate[],
  opts: { inline: boolean; budgetBytes?: number },
): InlinePlan {
  const inlined = candidates.map(() => false);

  if (!opts.inline) {
    return {
      inlined,
      note:
        candidates.length > 0
          ? 'inline: false — nothing inlined; see pngPath for each page.'
          : undefined,
    };
  }

  const budgetBytes = opts.budgetBytes ?? DEFAULT_INLINE_BUDGET_BYTES;
  let runningEncodedBytes = 0;
  let budgetExceeded = false;
  let lastInlinedPage: number | undefined;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (!candidate) continue;
    if (budgetExceeded) continue;
    const cost = encodedSize(candidate.bytes);
    if (runningEncodedBytes + cost <= budgetBytes) {
      runningEncodedBytes += cost;
      inlined[i] = true;
      lastInlinedPage = candidate.page;
    } else {
      budgetExceeded = true;
    }
  }

  if (!budgetExceeded) {
    return { inlined };
  }

  const pathsOnly = candidates.filter((_, i) => !inlined[i]).map((c) => c.page);
  const budgetMb = `${(budgetBytes / (1024 * 1024)).toFixed(0)} MB inline budget (on the base64-encoded payload)`;
  // The case worth wording carefully is a single page too big to inline at all — which is exactly
  // the one this feature exists for, a poster asked for at high dpi. Saying the budget "was
  // reached after page undefined" tells that caller nothing; naming the remedy does, because the
  // remedy is theirs to apply and cheap: fewer pixels, or a clip.
  const note =
    lastInlinedPage === undefined
      ? `page ${pathsOnly[0] ?? '?'} alone exceeds the ${budgetMb}, so no image is inlined — ` +
        `read it from pngPath, or ask for fewer pixels (lower dpi/maxEdgePx) or a clip of the ` +
        `region you care about`
      : `the ${budgetMb} was reached after page ${lastInlinedPage} — page(s) ` +
        `${pathsOnly.join(', ')} are paths-only; ask for fewer pixels (lower dpi/maxEdgePx) or a ` +
        `clip of the region you care about to fit more of them in`;
  return { inlined, note };
}
