import type { StructuredError } from '../types.js';

export interface ParsedLog {
  errors: StructuredError[];
  warnings: StructuredError[];
}

/** Return the last `n` lines of a log, for the raw escape hatch. */
export function logTail(log: string, n = 60): string {
  const lines = log.split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

function normalizeFile(file: string): string {
  return file.replace(/^\.\//, '');
}

function deriveRule(message: string): string {
  // First clause of the message, e.g. "Undefined control sequence." -> "Undefined control sequence".
  return message.split(/[.:]/)[0]?.trim() ?? message;
}

/**
 * Parse a LaTeX/latexmk log into structured errors and warnings. LaTeX logs are messy,
 * so this is best-effort and deliberately conservative; callers should also surface the
 * raw log tail. Works best with `-file-line-error`.
 */
export function parseLog(log: string): ParsedLog {
  const lines = log.split('\n');
  const errors: StructuredError[] = [];
  const warnings: StructuredError[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    // file-line-error format: "./main.tex:12: Undefined control sequence."
    const fle = /^(?:\.\/)?([^:\s][^:]*\.\w+):(\d+): (.+)$/.exec(line);
    if (fle && fle[1] && fle[2] && fle[3]) {
      errors.push({
        severity: 'error',
        file: normalizeFile(fle[1]),
        line: Number(fle[2]),
        message: fle[3].trim(),
        rule: deriveRule(fle[3]),
      });
      continue;
    }

    // TeX error line: "! Undefined control sequence." possibly followed by "l.12 ..."
    if (line.startsWith('! ')) {
      const message = line.slice(2).trim();
      let lineNo: number | undefined;
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const lm = /^l\.(\d+)/.exec(lines[j] ?? '');
        if (lm && lm[1]) {
          lineNo = Number(lm[1]);
          break;
        }
      }
      errors.push({ severity: 'error', message, line: lineNo, rule: deriveRule(message) });
      continue;
    }

    // Warnings from LaTeX, a package, or a class.
    const warn = /(?:LaTeX|Package (\w+)|Class (\w+)) Warning: (.+)/.exec(line);
    if (warn && warn[3]) {
      const message = warn[3].trim();
      const onLine =
        /on input line (\d+)/.exec(message) ?? /on input line (\d+)/.exec(lines[i + 1] ?? '');
      warnings.push({
        severity: 'warning',
        message,
        line: onLine && onLine[1] ? Number(onLine[1]) : undefined,
        rule: warn[1] ?? warn[2] ?? 'LaTeX',
      });
      continue;
    }

    // Overfull/Underfull boxes.
    const box = /^(Overfull|Underfull) \\([hv])box/.exec(line);
    if (box) {
      const lm = /at lines? (\d+)/.exec(line);
      warnings.push({
        severity: 'warning',
        message: line.trim(),
        line: lm && lm[1] ? Number(lm[1]) : undefined,
        rule: `${box[1]} \\${box[2]}box`,
      });
    }
  }

  return { errors: dedupe(errors), warnings: dedupe(warnings) };
}

function dedupe(items: StructuredError[]): StructuredError[] {
  const seen = new Set<string>();
  const out: StructuredError[] = [];
  for (const item of items) {
    const key = `${item.severity}|${item.file ?? ''}|${item.line ?? ''}|${item.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}
