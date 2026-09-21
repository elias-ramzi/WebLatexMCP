import { describe, it, expect } from 'vitest';
import { uncommittedModificationsMessage } from '../../src/services/gitService.js';

/**
 * `push` refuses to rebase over an uncommitted tracked file. Every exit that refusal used to
 * offer either PUBLISHES the file (`commit`, or a `message` to push) or DESTROYS it (`discard`) —
 * the ordinary "push section A while section B is mid-sentence" case had no safe way out. `shelve`
 * is that fourth exit, and the whole point of adding it is that the refusal the caller actually
 * reads names it. These tests pin the message itself: the four exits, the `shelve` call shape a
 * caller can copy verbatim, the existing `capList` caps, and the untracked note either way.
 *
 * `uncommittedModificationsMessage` is exported purely as this test seam (as
 * `untrackedOverwriteFromError` and `localChangesOverwriteFromError` already are) — its two call
 * sites inside `safePush`/`resolvePush` are unchanged, and reaching it through a real push would
 * mean standing up a remote to assert on a string.
 */
describe('uncommittedModificationsMessage', () => {
  const message = (modified = ['sections/method.tex'], untracked: string[] = []): string =>
    uncommittedModificationsMessage(modified, untracked);

  it('names all four exits: commit, a message to push, shelve, and discard', () => {
    const msg = message();
    expect(msg).toContain('`commit`');
    expect(msg).toContain('`message`');
    expect(msg).toContain('`shelve`');
    expect(msg).toContain('`discard`');
  });

  it('gives `shelve` a copyable call shape naming `paths`', () => {
    expect(message()).toContain('shelve { paths:');
  });

  it('says what makes shelve different: it neither publishes nor destroys, and unshelve brings it back', () => {
    const msg = message();
    expect(msg).toMatch(/neither publishes them nor destroys them/);
    expect(msg).toContain('`unshelve`');
  });

  // Ordering is the whole affordance: the caller reads the exits in the order they are offered,
  // and `shelve` has to sit between the two publishing routes and the destroying one, or the
  // safe exit reads as a footnote to `discard`.
  it('offers shelve after the `message` route and before `discard`', () => {
    const msg = message();
    const messageIdx = msg.indexOf('`message`');
    const shelveIdx = msg.indexOf('`shelve`');
    const discardIdx = msg.indexOf('`discard`');
    expect(messageIdx).toBeGreaterThanOrEqual(0);
    expect(shelveIdx).toBeGreaterThan(messageIdx);
    expect(discardIdx).toBeGreaterThan(shelveIdx);
  });

  it('names the modified paths', () => {
    const msg = message(['sections/method.tex', 'main.tex']);
    expect(msg).toContain('sections/method.tex');
    expect(msg).toContain('main.tex');
  });

  it('still caps the modified list at 20 and reports how many were cut', () => {
    const modified = Array.from({ length: 25 }, (_, i) => `sections/s${i}.tex`);
    const msg = message(modified);
    expect(msg).toContain('sections/s19.tex');
    expect(msg).not.toContain('sections/s20.tex');
    expect(msg).toContain('… 5 more');
  });

  it('still caps the untracked list at 10 and reports how many were cut', () => {
    const untracked = Array.from({ length: 13 }, (_, i) => `scratch/n${i}.md`);
    const msg = message(['main.tex'], untracked);
    expect(msg).toContain('scratch/n9.md');
    expect(msg).not.toContain('scratch/n10.md');
    expect(msg).toContain('… 3 more');
  });

  it('says untracked files ride along untouched when there are some', () => {
    const msg = message(['main.tex'], ['notes.md']);
    expect(msg).toContain('notes.md');
    expect(msg).toContain('will ride along untouched');
  });

  it('says untracked files never block a push when there are none', () => {
    const msg = message(['main.tex'], []);
    expect(msg).toContain('Untracked files never block a push.');
    expect(msg).not.toContain('ride along untouched');
  });
});
