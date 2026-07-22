/**
 * In-memory store of PDF review comments, keyed by project. A comment is a note the user attached
 * to a spot in the compiled PDF (via the viewer's text selection): it carries the selected text
 * (`quote`), the click point, and — when synctex resolved it — the source `file`/`line`. The
 * `list_comments` tool feeds these to Claude; `resolve_comments` marks them handled so the viewer
 * dims their markers. Ephemeral by design: working notes for one editing session, not persisted.
 */

export interface NewComment {
  page: number;
  /** Anchor point in PDF points from the top-left (for synctex), already resolved upstream. */
  x: number;
  y: number;
  /** The text the user selected in the PDF, if any. */
  quote?: string;
  /**
   * Selection rectangles in PDF coordinate space (`[x1,y1,x2,y2]` per line), for painting a
   * persistent highlight over the region in the viewer. Display-only; the source location comes
   * from the anchor `x`/`y`.
   */
  rects?: number[][];
  note: string;
  /** Source location, when synctex resolved it. */
  file?: string;
  line?: number;
}

export interface Comment extends NewComment {
  id: string;
  project: string;
  resolved: boolean;
  /** Stable 1-based number within the project, for the user to reference ("resolve comment 3"). */
  number: number;
  /** Monotonic insertion order, for stable sorting. */
  order: number;
}

/** How many recent deletions per project can be undone. */
const UNDO_LIMIT = 50;

export class CommentStore {
  private readonly byProject = new Map<string, Comment[]>();
  /** Per-project stack of recently deleted comments, most recent last (for undo). */
  private readonly deleted = new Map<string, Comment[]>();
  /** Per-project count of comments ever added, so numbers are stable and never reused. */
  private readonly issued = new Map<string, number>();
  private counter = 0;

  add(project: string, input: NewComment): Comment {
    const order = ++this.counter;
    const number = (this.issued.get(project) ?? 0) + 1;
    this.issued.set(project, number);
    const comment: Comment = { ...input, id: `c${order}`, project, resolved: false, number, order };
    const list = this.byProject.get(project);
    if (list) list.push(comment);
    else this.byProject.set(project, [comment]);
    return comment;
  }

  list(project: string, opts: { includeResolved?: boolean } = {}): Comment[] {
    const list = this.byProject.get(project) ?? [];
    const filtered = opts.includeResolved ? list : list.filter((c) => !c.resolved);
    return [...filtered].sort((a, b) => a.order - b.order);
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
    return true;
  }

  /** Restore the most recently deleted comment (in its original order); null if none to undo. */
  undo(project: string): Comment | null {
    const comment = this.deleted.get(project)?.pop();
    if (!comment) return null;
    const list = this.byProject.get(project);
    if (list) list.push(comment);
    else this.byProject.set(project, [comment]);
    return comment; // list() re-sorts by `order`, so it lands back in place
  }

  /** Mark the given ids resolved (or every open comment when `ids` is omitted); returns the count. */
  resolve(project: string, ids?: string[]): number {
    const list = this.byProject.get(project) ?? [];
    const want = ids ? new Set(ids) : undefined;
    let n = 0;
    for (const c of list) {
      if (!c.resolved && (!want || want.has(c.id))) {
        c.resolved = true;
        n++;
      }
    }
    return n;
  }

  /** Drop all comments for a project; returns how many were removed. */
  clear(project: string): number {
    const n = this.byProject.get(project)?.length ?? 0;
    this.byProject.set(project, []);
    return n;
  }
}
