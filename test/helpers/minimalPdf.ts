export interface MinimalPdfOptions {
  /**
   * One printed label per page, written into the catalog as a `/PageLabels` number tree with a
   * `/P` prefix entry per page and no `/S` style — so the label pdf.js reports back is exactly
   * the string given, whatever scheme it imitates (`"iv"`, `"A-3"`, a repeated `"1"`).
   * Omitted: no `/PageLabels` at all, which is what a plain `article` produces and what
   * `getPageLabels()` answers `null` for.
   */
  pageLabels?: string[];
  /**
   * Text to typeset on each page, 12pt Helvetica at a fixed position. Called with the 1-based
   * page number; returning `undefined` leaves that page with no text layer. A page's string may
   * carry `\n`, which is drawn as separate lines 14pt apart — so a test can assert on line
   * merging rather than on one blob.
   */
  text?: (page: number) => string | undefined;
}

/** Escape the three characters that are special inside a PDF literal string. */
function pdfString(s: string): string {
  return s.replace(/([\\()])/g, '\\$1');
}

/**
 * A minimal, valid N-page PDF. Each page draws one filled rectangle in a gray that differs per
 * page, so a test can tell rendered pages apart by their bytes. Hand-written rather than compiled,
 * so the render tests need no TeX install.
 *
 * `opts` adds the two things a hand-written PDF needs in order to stand in for a real document in
 * the label-resolution and text-extraction tests: a `/PageLabels` tree and a text layer. Both are
 * off by default, so every pre-existing caller gets byte-for-byte what it got before.
 */
export function minimalPdf(
  pages = 1,
  widthPt = 200,
  heightPt = 100,
  opts: MinimalPdfOptions = {},
): Buffer {
  const objs = new Map<number, string>();
  const kids: string[] = [];
  const wantsFont = opts.text !== undefined;
  // Object 3 is the font when one is needed, so the page/content numbering below just starts one
  // higher — keeping the no-text layout identical to what this helper always produced.
  let next = wantsFont ? 4 : 3;
  const fontNum = 3;
  const pageObjs: Array<{ contentNum: number; pageNum: number; stream: string }> = [];
  for (let i = 0; i < pages; i++) {
    const gray = (0.2 + 0.2 * i).toFixed(2);
    let stream = `${gray} g 10 10 ${widthPt - 20} ${heightPt - 20} re f`;
    const text = opts.text?.(i + 1);
    if (text !== undefined) {
      const drawn = text
        .split('\n')
        .map((line, n) => `BT /F1 12 Tf 20 ${heightPt - 30 - n * 14} Td (${pdfString(line)}) Tj ET`)
        .join('\n');
      stream += `\n${drawn}`;
    }
    const contentNum = next++;
    const pageNum = next++;
    pageObjs.push({ contentNum, pageNum, stream });
    kids.push(`${pageNum} 0 R`);
  }
  const pageLabels =
    opts.pageLabels === undefined
      ? ''
      : ` /PageLabels << /Nums [${opts.pageLabels
          .map((label, i) => `${i} << /P (${pdfString(label)}) >>`)
          .join(' ')}] >>`;
  objs.set(1, `<< /Type /Catalog /Pages 2 0 R${pageLabels} >>`);
  objs.set(2, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`);
  if (wantsFont) {
    objs.set(fontNum, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  }
  const resources = wantsFont ? `<< /Font << /F1 ${fontNum} 0 R >> >>` : '<< >>';
  for (const p of pageObjs) {
    objs.set(p.contentNum, `<< /Length ${p.stream.length} >>\nstream\n${p.stream}\nendstream`);
    objs.set(
      p.pageNum,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] /Contents ${p.contentNum} 0 R /Resources ${resources} >>`,
    );
  }
  const maxObjNum = Math.max(...objs.keys());
  let out = '%PDF-1.4\n';
  const offsets = new Map<number, number>();
  for (let i = 1; i <= maxObjNum; i++) {
    const body = objs.get(i);
    if (body === undefined) {
      continue;
    }
    offsets.set(i, out.length);
    out += `${i} 0 obj\n${body}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${maxObjNum + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxObjNum; i++) {
    const offset = offsets.get(i) ?? 0;
    out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${maxObjNum + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
