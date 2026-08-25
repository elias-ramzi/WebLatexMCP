/**
 * A minimal, valid N-page PDF. Each page draws one filled rectangle in a gray that differs per
 * page, so a test can tell rendered pages apart by their bytes. Hand-written rather than compiled,
 * so the render tests need no TeX install.
 */
export function minimalPdf(pages = 1, widthPt = 200, heightPt = 100): Buffer {
  const objs = new Map<number, string>();
  const kids: string[] = [];
  let next = 3;
  const pageObjs: Array<{ contentNum: number; pageNum: number; stream: string }> = [];
  for (let i = 0; i < pages; i++) {
    const gray = (0.2 + 0.2 * i).toFixed(2);
    const stream = `${gray} g 10 10 ${widthPt - 20} ${heightPt - 20} re f`;
    const contentNum = next++;
    const pageNum = next++;
    pageObjs.push({ contentNum, pageNum, stream });
    kids.push(`${pageNum} 0 R`);
  }
  objs.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  objs.set(2, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`);
  for (const p of pageObjs) {
    objs.set(p.contentNum, `<< /Length ${p.stream.length} >>\nstream\n${p.stream}\nendstream`);
    objs.set(
      p.pageNum,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] /Contents ${p.contentNum} 0 R /Resources << >> >>`,
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
