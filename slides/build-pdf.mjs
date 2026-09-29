// Prints the deck to a PDF with a headless Chrome, Chromium or Edge, using reveal.js's own print
// layout (`?print-pdf`): one page per slide, at the deck's 1280×720 size.
//
//   npm run slides:pdf                 → slides/WebLatexMCP.pdf
//   npm run slides:pdf -- out/deck.pdf → a path of your choice
//
// Set CHROME_PATH to pick the browser. Otherwise the first one found is used: on PATH, then the
// usual install locations — including a Windows browser seen from WSL, which is driven with
// Windows paths because it cannot open Linux ones. The deck loads reveal.js and its fonts from
// CDNs, so building needs a network connection.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const input = path.join(here, 'index.html');
const output = path.resolve(process.argv[2] ?? path.join(here, 'WebLatexMCP.pdf'));

function onPath(names) {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function findBrowser() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const env = process.env;
  const byPlatform = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
    win32: [
      `${env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
      `${env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
      `${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      `${env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ],
    linux: [
      // WSL: the Windows browsers, reached through the /mnt/c mount.
      '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
      '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ],
  };
  const fromPath = onPath([
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'microsoft-edge',
    'chrome',
    'msedge',
  ]);
  if (fromPath) return fromPath;
  return (byPlatform[process.platform] ?? []).find((p) => existsSync(p)) ?? null;
}

// A Windows browser launched from WSL needs Windows paths for the page and the PDF it writes.
const wslToWindows = (p) => execFileSync('wslpath', ['-w', p], { encoding: 'utf8' }).trim();

const browser = findBrowser();
if (!browser) {
  process.stderr.write(
    'No Chrome, Chromium or Edge found. Install one, or point CHROME_PATH at its executable.\n',
  );
  process.exit(1);
}

const viaWsl = process.platform === 'linux' && browser.toLowerCase().endsWith('.exe');
const pageUrl = viaWsl
  ? `file:${wslToWindows(input).replaceAll('\\', '/')}`
  : pathToFileURL(input).href;
const pdfPath = viaWsl ? wslToWindows(output) : output;

const result = spawnSync(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-pdf-header-footer',
    // Time for the CDN scripts and fonts to load and reveal.js to lay out every slide.
    '--virtual-time-budget=15000',
    `--print-to-pdf=${pdfPath}`,
    `${pageUrl}?print-pdf`,
  ],
  { encoding: 'utf8', timeout: 120_000 },
);

if (result.error || result.status !== 0 || !existsSync(output)) {
  process.stderr.write(`Printing with ${browser} failed.\n`);
  if (result.error) process.stderr.write(`${result.error.message}\n`);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(1);
}
process.stdout.write(`Wrote ${path.relative(process.cwd(), output) || output}\n`);
