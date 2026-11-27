import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { stampLines, stampText } from '../../src/lib/stampedLines.js';

describe('stampText', () => {
  it('stamps the start of each line, once for a line written in pieces', () => {
    expect(stampText('a\nb\n', true, 'T')).toEqual({ text: 'T a\nT b\n', atLineStart: true });
    expect(stampText('half', true, 'T')).toEqual({ text: 'T half', atLineStart: false });
    expect(stampText(' more\nnext', false, 'U')).toEqual({
      text: ' more\nU next',
      atLineStart: false,
    });
    expect(stampText('', true, 'T')).toEqual({ text: '', atLineStart: true });
    expect(stampText('\r\n', true, 'T')).toEqual({ text: 'T \r\n', atLineStart: true });
  });
});

describe('stampLines', () => {
  it('stamps what a stream is given, strings and split UTF-8 bytes alike, until restored', async () => {
    const written: string[] = [];
    const sink = new Writable({
      decodeStrings: false,
      write(chunk: string | Buffer, _enc, cb) {
        written.push(chunk.toString());
        cb();
      },
    });
    let clock = Date.UTC(2026, 10, 27, 16, 0, 12, 552);
    const restore = stampLines(sink, () => new Date(clock++));
    sink.write('[web-latex-mcp] session "a" opened\n');
    const bytes = Buffer.from('thèse\n');
    // "è" is two bytes: split between them, as a piped worker's stderr may be.
    sink.write(bytes.subarray(0, 3));
    sink.write(bytes.subarray(3));
    const called = new Promise<void>((r) => sink.write('last\n', () => r()));
    restore();
    sink.write('plain\n');
    expect(written.join('')).toBe(
      '2026-11-27T16:00:12.552Z [web-latex-mcp] session "a" opened\n' +
        '2026-11-27T16:00:12.553Z thèse\n' +
        '2026-11-27T16:00:12.555Z last\n' +
        'plain\n',
    );
    await called; // the caller's callback is passed on
  });
});
