import { describe, it, expect } from 'vitest';
import { compileViewerHint, shouldOpenExternally, viewerHint } from '../../src/lib/viewerHint.js';

describe('shouldOpenExternally', () => {
  it('never opens the OS browser in vscode mode', () => {
    expect(shouldOpenExternally('vscode', true)).toBe(false);
    expect(shouldOpenExternally('vscode', undefined)).toBe(false);
  });

  it('opens by default in browser mode, honoring an explicit open flag', () => {
    expect(shouldOpenExternally('browser', undefined)).toBe(true);
    expect(shouldOpenExternally('browser', true)).toBe(true);
    expect(shouldOpenExternally('browser', false)).toBe(false);
  });
});

describe('compileViewerHint', () => {
  it('shows the live URL when the viewer is already running', () => {
    const hint = compileViewerHint('http://127.0.0.1:41725/p/demo');
    expect(hint).toContain('http://127.0.0.1:41725/p/demo');
    expect(hint).toMatch(/refreshed/);
  });

  it('advertises the viewer (and the comment loop) when it is not running', () => {
    const hint = compileViewerHint(undefined);
    expect(hint).toMatch(/`viewer`/);
    expect(hint).toMatch(/comments/);
    expect(hint).not.toContain('127.0.0.1');
  });
});

describe('viewerHint', () => {
  const url = 'http://127.0.0.1:41725/p/demo';

  it('gives Simple Browser instructions in vscode mode', () => {
    const hint = viewerHint(url, 'vscode', false);
    expect(hint).toContain(url);
    expect(hint).toMatch(/Simple Browser/);
    expect(hint).not.toMatch(/Opened in your browser/);
  });

  it('reports whether the browser was opened in browser mode', () => {
    expect(viewerHint(url, 'browser', true)).toMatch(/Opened in your browser/);
    expect(viewerHint(url, 'browser', false)).toMatch(/Open this URL in a browser/);
  });
});
