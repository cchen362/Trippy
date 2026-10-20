// Plan 37 W1 — render the synthetic fixtures tests/documentText.test.js reads.
//
//   cd backend; node scripts/renderDocumentTextFixtures.mjs [--chrome <path-to-chrome-headless-shell>]
//
// Writes, under tests/fixtures/documentText/:
//   cjk-checkin.pdf         a one-page Japanese confirmation with a real text layer, full-width digits
//                           included (Chromium --print-to-pdf)
//   scanned-checkin.pdf     a one-page PDF whose only content is a screenshot of an English confirmation:
//                           pages exist, no text layer (what a scanned PDF looks like to pdfjs)
//   checkin-screenshot.png  that screenshot on its own (an image upload)
//
// hotel-kanade-2p.pdf (the two-page text-layer PDF) is rendered by modelEval/renderFactsFixtures.mjs and
// copied here unchanged. Everything is invented: a fictional ryokan, a fictional hotel, a fictional guest.
// After rendering, each file is read back with the production extractor and the script fails loudly
// unless the CJK PDF's text layer holds its check-in line and the scanned PDF has none. Chrome stamps its
// creation date into PDF metadata, so the bytes differ between runs; the content does not.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, runChrome } from './modelEval/lib/chromium.mjs';
import { extractPdfPages, findQuote, hasTextLayer } from '../src/services/documentText.js';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'documentText');

const e = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CJK_LINES = [
  '旅館みなと ご予約確認書',
  'ご予約番号：MN-7731',
  'チェックインは１５：００から１９：００までです。',
  'チェックアウトは10:00までにお願いいたします。',
  'キャンセル料：ご宿泊日の3日前（2026年11月17日）まで無料です。',
  '入湯税として1名様1泊150円を現地でお支払いください。',
];

const SCREENSHOT_LINES = [
  'Hotel Kanade Kyoto - booking KND-48213',
  'Check-in is available from 15:00 to 23:00.',
  'Free cancellation until 12 November 2026, 18:00.',
  'Reception is open from 07:00 to 23:00.',
];

const PAGE_CSS = `
@page{size:A4;margin:20mm}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:"Yu Gothic","MS Gothic","Segoe UI",sans-serif;color:#1d2430;font-size:13pt;line-height:1.7}
p{margin:0 0 10px}
`;

const cjkHtml = () => `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>旅館みなと</title><style>${PAGE_CSS}</style></head>
<body>${CJK_LINES.map((l) => `<p>${e(l)}</p>`).join('')}</body></html>`;

const screenshotHtml = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>screenshot</title>
<style>html,body{margin:0;padding:0;background:#fff}
body{width:640px;height:260px;padding:24px;font-family:"Segoe UI",sans-serif;color:#1d2430;font-size:20px;line-height:1.6}
p{margin:0 0 8px}</style></head>
<body>${SCREENSHOT_LINES.map((l) => `<p>${e(l)}</p>`).join('')}</body></html>`;

const scannedHtml = (pngBase64) => `<!doctype html>
<html><head><meta charset="utf-8"><title>scan</title>
<style>@page{size:A4;margin:20mm}html,body{margin:0;padding:0}img{width:100%;display:block}</style></head>
<body><img src="data:image/png;base64,${pngBase64}" alt=""></body></html>`;

function parseArgs(argv) {
  const args = { chrome: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--chrome') args.chrome = argv[++i];
    else throw new Error(`unexpected argument ${argv[i]}`);
  }
  return args;
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const chrome = findChrome(args);
  console.log(`chrome: ${chrome}`);
  const work = mkdtempSync(join(tmpdir(), 'trippy-documenttext-render-'));
  const profile = join(work, 'profile');
  try {
    const cjkHtmlPath = join(work, 'cjk.html');
    writeFileSync(cjkHtmlPath, cjkHtml(), 'utf8');
    const cjkPath = join(OUT_DIR, 'cjk-checkin.pdf');
    runChrome(chrome, profile, ['--no-pdf-header-footer', `--print-to-pdf=${cjkPath}`], cjkHtmlPath, cjkPath);

    const shotHtmlPath = join(work, 'screenshot.html');
    writeFileSync(shotHtmlPath, screenshotHtml(), 'utf8');
    const pngPath = join(OUT_DIR, 'checkin-screenshot.png');
    runChrome(chrome, profile, ['--hide-scrollbars', '--window-size=688,308', `--screenshot=${pngPath}`], shotHtmlPath, pngPath);

    const scannedHtmlPath = join(work, 'scanned.html');
    writeFileSync(scannedHtmlPath, scannedHtml(readFileSync(pngPath).toString('base64')), 'utf8');
    const scannedPath = join(OUT_DIR, 'scanned-checkin.pdf');
    runChrome(chrome, profile, ['--no-pdf-header-footer', `--print-to-pdf=${scannedPath}`], scannedHtmlPath, scannedPath);

    const cjk = await extractPdfPages(readFileSync(cjkPath));
    expect(cjk.pageCount === 1, `${cjkPath}: ${cjk.pageCount} pages, expected 1`);
    expect(hasTextLayer(cjk.pages), `${cjkPath}: no text layer`);
    for (const quote of ['チェックインは15:00から', 'チェックアウトは10:00まで', '入湯税として1名様1泊150円']) {
      expect(findQuote(cjk.pages, quote).found, `${cjkPath}: "${quote}" not found in the text layer`);
    }

    const scanned = await extractPdfPages(readFileSync(scannedPath));
    expect(scanned.pageCount === 1, `${scannedPath}: ${scanned.pageCount} pages, expected 1`);
    expect(!hasTextLayer(scanned.pages), `${scannedPath}: has a text layer, expected none`);
    expect(!findQuote(scanned.pages, '15:00').found, `${scannedPath}: "15:00" found, expected no text`);

    for (const path of [cjkPath, scannedPath, pngPath]) console.log(`${path}  ${statSync(path).size} bytes`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
