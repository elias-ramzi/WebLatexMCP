import type { LatexCompiler } from './compiler.js';
import type { PdfRenderService } from './pdfRender.js';
import type { WorkGate } from '../lib/workGate.js';

/**
 * The compiler and the PDF renderer behind the process's {@link WorkGate}, so the tools need not
 * know the limit exists. Only the calls that run TeX or load a PDF take a slot; the availability
 * probes (`isAvailable`, `canRasterize`) do not, since they are cheap and memoised.
 *
 * No gated call makes another one: `compile`'s page count runs after its build, not inside it,
 * and a renderer method's own helpers call the inner renderer — so a limit of 1 cannot deadlock.
 */

export function gatedCompiler(inner: LatexCompiler, gate: WorkGate): LatexCompiler {
  return {
    isAvailable: () => inner.isAvailable(),
    compile: (req) => gate.run(() => inner.compile(req)),
  };
}

export function gatedRenderer(inner: PdfRenderService, gate: WorkGate): PdfRenderService {
  return {
    pageCount: (pdfPath) => gate.run(() => inner.pageCount(pdfPath)),
    render: (req) => gate.run(() => inner.render(req)),
    canRasterize: () => inner.canRasterize(),
    geometry: (req) => gate.run(() => inner.geometry(req)),
    pageLabels: (pdfPath) => gate.run(() => inner.pageLabels(pdfPath)),
    pageLabelsAndCount: (pdfPath) => gate.run(() => inner.pageLabelsAndCount(pdfPath)),
    text: (req) => gate.run(() => inner.text(req)),
    destinationPages: (pdfPath, names) => gate.run(() => inner.destinationPages(pdfPath, names)),
  };
}
