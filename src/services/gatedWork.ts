import type { LatexCompiler } from './compiler.js';
import type { PdfRenderService } from './pdfRender.js';
import type { WorkGate } from '../lib/workGate.js';
import { noteGateWait, timedPhase } from '../lib/callLog.js';

/**
 * `gate.run(job)`, charging the wait for a slot and the job's own time to the tool call running
 * now (`src/lib/callLog.ts`), under `phase`.
 */
function timed<T>(gate: WorkGate, phase: string, job: () => Promise<T>): Promise<T> {
  const asked = Date.now();
  return gate.run(() => {
    noteGateWait(Date.now() - asked);
    return timedPhase(phase, job);
  });
}

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
    compile: (req) => timed(gate, 'compile', () => inner.compile(req)),
  };
}

export function gatedRenderer(inner: PdfRenderService, gate: WorkGate): PdfRenderService {
  return {
    pageCount: (pdfPath) => timed(gate, 'pdf', () => inner.pageCount(pdfPath)),
    render: (req) => timed(gate, 'pdf', () => inner.render(req)),
    canRasterize: () => inner.canRasterize(),
    geometry: (req) => timed(gate, 'pdf', () => inner.geometry(req)),
    pageLabels: (pdfPath) => timed(gate, 'pdf', () => inner.pageLabels(pdfPath)),
    pageLabelsAndCount: (pdfPath) => timed(gate, 'pdf', () => inner.pageLabelsAndCount(pdfPath)),
    text: (req) => timed(gate, 'pdf', () => inner.text(req)),
    destinationPages: (pdfPath, names) =>
      timed(gate, 'pdf', () => inner.destinationPages(pdfPath, names)),
  };
}
