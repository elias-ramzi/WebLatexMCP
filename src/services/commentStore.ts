/**
 * In-memory store of review comments, keyed by project. A comment is a note the user attached to a
 * spot in the compiled PDF or in a markdown document of the project (via the viewer's text
 * selection): it carries the selected text (`quote`), the anchor, and — when resolved — the source
 * `file`/`line`. Each project has several **surfaces**: the PDF (surface `''`) and every document
 * comments were made on (surface = its `document` path); numbering is per surface. The
 * `list_comments` tool feeds these to Claude; `resolve_comments` marks them handled so the viewer
 * dims their markers. Ephemeral by design: working notes for one editing session, not persisted.
 */

/**
 * A new comment. Two shapes share it:
 *
 *  - a **PDF comment** has `page`/`x`/`y` (and `file`/`line` when synctex resolved the anchor);
 *  - a **document comment** has `document` (the project-relative POSIX path of the markdown
 *    document it was made on) and no `page`/`x`/`y`; its `file`/`line` are that document and the
 *    source line the server resolved for the selection.
 */
export interface NewComment {
  /** The markdown document the comment was made on (project-relative, POSIX). Absent for a PDF
   * comment. */
  document?: string;
  /** PDF page (1-based). PDF comments only. */
  page?: number;
  /** Anchor point in PDF points from the top-left (for synctex), already resolved upstream. PDF
   * comments only. */
  x?: number;
  y?: number;
  /** The text the user selected, if any. */
  quote?: string;
  /**
   * Selection rectangles in PDF coordinate space (`[x1,y1,x2,y2]` per line), for painting a
   * persistent highlight over the region in the viewer. Display-only; the source location comes
   * from the anchor `x`/`y`.
   */
  rects?: number[][];
  note: string;
  /** Source location: synctex's for a PDF comment, the document and resolved line for a document
   * comment. */
  file?: string;
  line?: number;
}

export interface Comment extends NewComment {
  id: string;
  project: string;
  resolved: boolean;
  /**
   * 1-based position among the open comments of the comment's **surface** (the PDF, or one
   * document) in its project, so the user always sees #1..#N with no gaps on each surface.
   * Recomputed whenever the open set changes (add / resolve / delete / undo), so a number
   * identifies a comment only as of the latest listing — act on `id`, not on a remembered number.
   */
  number: number;
  /** Monotonic insertion order, for stable sorting. */
  order: number;
}

/** How many recent deletions per project can be undone. */
const UNDO_LIMIT = 50;

/**
 * Which surface(s) a call addresses: `undefined` every surface of the project, `null` the PDF only,
 * a string that one document only.
 */
export type SurfaceFilter = string | null | undefined;

/** The surface a comment belongs to: its document, or `''` for the PDF. */
function surfaceOf(c: NewComment): string {
  return c.document ?? '';
}

function onSurface(c: NewComment, filter: SurfaceFilter): boolean {
  if (filter === undefined) return true;
  return surfaceOf(c) === (filter ?? '');
}

export class CommentStore {
  private readonly byProject = new Map<string, Comment[]>();
  /** Per-project stack of recently deleted comments, most recent last (for undo). */
  private readonly deleted = new Map<string, Comment[]>();
  private counter = 0;

  add(project: string, input: NewComment): Comment {
    const order = ++this.counter;
    const comment: Comment = {
      ...input,
      id: `c${order}`,
      project,
      resolved: false,
      number: 0,
      order,
    };
    const list = this.byProject.get(project);
    if (list) list.push(comment);
    else this.byProject.set(project, [comment]);
    this.renumber(project); // fills in `number` on the comment we just pushed
    return comment;
  }

  /**
   * Re-assign #1..#N over each surface's open comments in insertion order, closing any gaps. Every
   * surface of the project is renumbered, so no caller has to know which one changed.
   */
  private renumber(project: string): void {
    const list = this.byProject.get(project);
    if (!list) return;
    const next = new Map<string, number>();
    for (const c of [...list].sort((a, b) => a.order - b.order)) {
      if (c.resolved) continue;
      const n = (next.get(surfaceOf(c)) ?? 0) + 1;
      next.set(surfaceOf(c), n);
      c.number = n;
    }
  }

  /**
   * The project's comments in insertion order. `document`: `undefined` every surface, `null` PDF
   * comments only, a string that document's only.
   */
  list(
    project: string,
    opts: { includeResolved?: boolean; document?: string | null } = {},
  ): Comment[] {
    const list = this.byProject.get(project) ?? [];
    const filtered = list.filter(
      (c) => (opts.includeResolved || !c.resolved) && onSurface(c, opts.document),
    );
    return filtered.sort((a, b) => a.order - b.order);
  }

  /** Edit a comment's note in place; returns the updated comment, or null if not found. */
  update(project: string, id: string, patch: { note?: string }): Comment | null {
    const comment = this.byProject.get(project)?.find((c) => c.id === id);
    if (!comment) return null;
    if (patch.note !== undefined) comment.note = patch.note;
    return comment;
  }

  /** Remove a single comment (stashing it for undo); returns whether one was removed. */
  remove(project: string, id: string): boolean {
    const list = this.byProject.get(project);
    if (!list) return false;
    const i = list.findIndex((c) => c.id === id);
    if (i === -1) return false;
    const [removed] = list.splice(i, 1);
    const stack = this.deleted.get(project) ?? [];
    stack.push(removed!);
    if (stack.length > UNDO_LIMIT) stack.shift();
    this.deleted.set(project, stack);
    this.renumber(project);
    return true;
  }

  /**
   * Restore the most recently deleted comment of the given surface (`undefined`: of any surface,
   * `null`: the PDF, a string: that document), in its original order; null if none to undo. One
   * stack per project, searched from the top.
   */
  undo(project: string, document?: string | null): Comment | null {
    const stack = this.deleted.get(project);
    if (!stack) return null;
    let i = stack.length - 1;
    while (i >= 0 && !onSurface(stack[i]!, document)) i--;
    if (i < 0) return null;
    const [comment] = stack.splice(i, 1);
    if (!comment) return null;
    const list = this.byProject.get(project);
    if (list) list.push(comment);
    else this.byProject.set(project, [comment]);
    this.renumber(project);
    return comment; // list() re-sorts by `order`, so it lands back in place
  }

  /**
   * Mark the given ids resolved, or — when `ids` is omitted — every open comment of the given
   * surface (`undefined`: every surface, `null`: the PDF, a string: that document). Ids are unique
   * across surfaces, so `document` is ignored when `ids` is given. Returns the count.
   */
  resolve(project: string, ids?: string[], document?: string | null): number {
    const list = this.byProject.get(project) ?? [];
    const want = ids ? new Set(ids) : undefined;
    let n = 0;
    for (const c of list) {
      if (!c.resolved && (want ? want.has(c.id) : onSurface(c, document))) {
        c.resolved = true;
        n++;
      }
    }
    if (n > 0) this.renumber(project); // remaining open comments close the gaps: #1..#N
    return n;
  }

  /** Drop all comments for a project; returns how many were removed. */
  clear(project: string): number {
    const n = this.byProject.get(project)?.length ?? 0;
    this.byProject.set(project, []);
    return n;
  }
}
