import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
// The same matcher `@anthropic-ai/mcpb pack` applies `.mcpbignore` with (its dist/node/files.js:
// `ignore().add(EXCLUDE_PATTERNS).add(additionalPatterns)`), so this judges the file with the
// packer's own gitignore semantics rather than a re-implementation of them.
import ignoreModule from 'ignore';
import { PDFJS_SPECIFIER } from '../../src/services/pdfRender.js';

/**
 * What the Claude Desktop extension ships is decided by `.mcpbignore`, and nothing else in the
 * test suite ever looks at the packed artifact — so a pattern that strips a module the server
 * imports at runtime is invisible until a user's tool call dies on it. 0.7.0 did exactly that:
 * `.mcpbignore` dropped `node_modules/pdfjs-dist/legacy/` (the comment said pdf.js was never
 * imported in Node, which stopped being true when page counts, text and geometry arrived), and
 * every PDF tool in the extension failed with "Cannot find module …pdf.mjs".
 */

// `ignore` is CommonJS (`module.exports = factory`), typed `export = ignore` since 7.x, so the
// default import IS the factory — under NodeNext and at runtime alike.
const ignore = ignoreModule;
type Ignore = ReturnType<typeof ignore>;

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** `.mcpbignore` parsed the way mcpb's `readMcpbIgnorePatterns` does. */
function mcpbIgnore(): Ignore {
  const patterns = readFileSync(path.join(REPO_ROOT, '.mcpbignore'), 'utf-8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  return ignore().add(patterns);
}

/**
 * Where a module lands in the bundle, as a POSIX path relative to the bundle root. Taken from
 * the package root rather than from `path.relative(REPO_ROOT, …)`, because `require.resolve`
 * returns a realpath and a worktree's node_modules can be a symlink out of the repo — while the
 * bundle is always packed from a hoisted `npm ci` install, where the package sits at
 * `node_modules/<name>/`.
 */
function bundlePath(specifier: string): string {
  const req = createRequire(import.meta.url);
  const pkgName = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : (specifier.split('/')[0] ?? specifier);
  const pkgRoot = path.dirname(req.resolve(`${pkgName}/package.json`));
  const inPkg = path.relative(pkgRoot, req.resolve(specifier)).split(path.sep).join('/');
  return `node_modules/${pkgName}/${inPkg}`;
}

describe('.mcpbignore', () => {
  const ig = mcpbIgnore();

  it('ships the pdf.js build the server imports in Node', () => {
    const entry = bundlePath(PDFJS_SPECIFIER);
    expect(entry).toBe('node_modules/pdfjs-dist/legacy/build/pdf.mjs');
    expect(ig.ignores(entry)).toBe(false);
  });

  it("ships that build's worker, which pdf.js loads beside itself in Node", () => {
    // pdf.js in Node runs a "fake worker" in-process by importing `./pdf.worker.mjs` relative to
    // its own file; shipping the entry without it fails on the first getDocument() instead.
    const worker = path.posix.join(
      path.posix.dirname(bundlePath(PDFJS_SPECIFIER)),
      'pdf.worker.mjs',
    );
    expect(ig.ignores(worker)).toBe(false);
  });

  it('ships the built server itself (the matcher is not vacuously permissive)', () => {
    expect(ig.ignores('dist/services/pdfRender.js')).toBe(false);
    // ...and it does apply the file: sources and a source map stay out.
    expect(ig.ignores('src/services/pdfRender.ts')).toBe(true);
    expect(ig.ignores('node_modules/pdfjs-dist/legacy/build/pdf.mjs.map')).toBe(true);
  });

  it('leaves out the per-platform native canvas backend, which render_pages alone needs', () => {
    // A deliberate exclusion, pinned so the render_pages refusal that names the Desktop extension
    // stays true: the bundle is built once, on ubuntu, and this is a per-platform binary.
    expect(ig.ignores('node_modules/@napi-rs/canvas/index.js')).toBe(true);
  });
});
