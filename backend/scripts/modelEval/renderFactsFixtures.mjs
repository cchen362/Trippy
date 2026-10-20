// Plan 37 W0 — render the committed synthetic facts fixtures.
//
//   cd backend; node scripts/modelEval/renderFactsFixtures.mjs [--chrome <path-to-chrome-headless-shell>]
//
// Writes, under fixtures/facts/ (read by `facts.mjs --fixtures`):
//   files/hotel-kanade-2p.pdf       a two-page A4 hotel confirmation with a real text layer (Chromium
//                                   --print-to-pdf; a CSS page break makes page 2 really page 2)
//   files/ryokan-minato.txt         a short Japanese pasted-text confirmation, full-width digits included
//   hotel-kanade-2p.json            fixture manifests: booking context and an `expected` block listing
//   ryokan-minato-text.json         what a correct reader finds (a guide for a human and the summary;
//                                   facts.mjs passes it through to the record, nothing scores against it)
//
// Everything is invented: a fictional hotel, a fictional ryokan, a fictional guest. After rendering,
// the PDF is read back with extractPdfPages and the script fails loudly unless it has two pages, "15:00"
// is found on page 1 and "07:00" on page 2 — the page-number path of D-37-2 is only testable if page 2
// really is page 2. Chrome stamps its creation date into the PDF metadata, so the bytes differ between
// runs; the page content does not.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_DIR } from './lib/runner.mjs';
import { findChrome, runChrome } from './lib/chromium.mjs';
import { extractPdfPages } from './lib/documentText.mjs';
import { findQuote } from './lib/factsContract.mjs';

const FIXTURE_DIR = join(FIXTURES_DIR, 'facts');
const FILES_DIR = join(FIXTURE_DIR, 'files');

const e = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- hotel PDF -------------------------------------------------------------------------

const PAGE_1 = [
  'Check-in is available from 15:00 to 23:00 on the day of arrival.',
  'Check-out is by 11:00 on the day of departure.',
  'Free cancellation until 12 November 2026, 18:00 (Japan time). After that, 100% of the first night will be charged.',
  'Guests who are not residents of Japan must present a valid passport at check-in.',
  'The credit card used to make this booking must be shown at check-in.',
  'Accommodation tax of ¥200 per person per night is payable at the hotel.',
];

const PAGE_2 = [
  'Reception is open from 07:00 to 23:00.',
  'Guests arriving after 23:00 must notify the hotel by phone on +81 75 000 0000.',
  'Breakfast is served from 07:00 to 10:00 and is included for 2 guests.',
  'Luggage cannot be stored after check-out.',
];

const MARKETING =
  'Hotel Kanade Kyoto sits among the quiet lanes of eastern Kyoto, where the mornings smell of cedar and ' +
  'the evenings belong to lantern light. We hope your stay is a restful one, and we look forward to welcoming you.';

const HOTEL_CSS = `
@page{size:A4;margin:18mm}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:"Segoe UI","Yu Gothic",sans-serif;color:#1d2430;font-size:11pt;line-height:1.5}
.top{border-bottom:3px solid #2f5d50;padding-bottom:10px;margin-bottom:20px}
.top .brand{font-size:24pt;font-weight:800;color:#2f5d50}
.top .doc{font-size:11pt;color:#5b6573}
h1{font-size:17pt;margin:0 0 14px}
table.stay{border-collapse:collapse;margin-bottom:22px}
table.stay td{padding:5px 18px 5px 0;vertical-align:top}
table.stay td:first-child{color:#5b6573}
h2{font-size:12pt;margin:22px 0 10px;color:#2f5d50;text-transform:uppercase;letter-spacing:.6px}
ul.terms{margin:0;padding-left:20px}
ul.terms li{margin-bottom:12px}
.pagebreak{break-after:page;page-break-after:always}
p.note{margin-top:30px;color:#444}
`;

const list = (items) => `<ul class="terms">${items.map((t) => `<li>${e(t)}</li>`).join('')}</ul>`;

function hotelHtml() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Hotel Kanade Kyoto - Booking Confirmation KND-48213</title>
<style>${HOTEL_CSS}</style></head><body>
<section class="pagebreak">
<div class="top"><div class="brand">Hotel Kanade Kyoto</div><div class="doc">Booking confirmation</div></div>
<h1>Your stay is confirmed</h1>
<table class="stay">
<tr><td>Guest</td><td>Alex Example</td></tr>
<tr><td>Confirmation number</td><td>KND-48213</td></tr>
<tr><td>Arrival</td><td>14 November 2026</td></tr>
<tr><td>Departure</td><td>17 November 2026 (3 nights)</td></tr>
</table>
<h2>Check-in, cancellation and payment</h2>
${list(PAGE_1)}
</section>
<section>
<div class="top"><div class="brand">Hotel Kanade Kyoto</div><div class="doc">Booking confirmation, page 2</div></div>
<h2>Reception and services</h2>
${list(PAGE_2)}
<p class="note">${e(MARKETING)}</p>
</section>
</body></html>`;
}

// ---------- ryokan text -----------------------------------------------------------------------

// Full-width digits and colon in the check-in line, half-width elsewhere, so NFKC matching is
// exercised by a real confirmation shape.
const RYOKAN_TEXT = `旅館みなと ご予約確認書

ご予約番号：MN-7731
お客様名：アレックス サンプル 様
ご宿泊日：2026年11月20日～2026年11月22日（2泊）

チェックイン：１５：００～１９：００
チェックアウト：10:00
夕食は18:30からです。ご到着が遅れる場合はお電話でご連絡ください。
キャンセル料：ご宿泊日の3日前（2026年11月17日）まで無料です。それ以降は宿泊料金の100%を頂戴いたします。
入湯税として1名様1泊150円を現地でお支払いください。
`;

// ---------- manifests -------------------------------------------------------------------------

const TRIP = { startDate: '2026-11-13', endDate: '2026-11-23' };

const HOTEL_FIXTURE = {
  id: 'hotel-kanade-2p',
  trip: 'synthetic-kyoto',
  tripTitle: 'Kyoto in November (synthetic)',
  description: 'Two-page A4 hotel confirmation with a real text layer; page 2 holds reception hours, the late-arrival rule and breakfast, plus one marketing paragraph that must be skipped (prompt rule 3).',
  bookingContext: {
    bookings: [{
      type: 'hotel',
      title: 'Hotel Kanade Kyoto',
      startDatetime: '2026-11-14T15:00',
      endDatetime: '2026-11-17T11:00',
      originTz: 'Asia/Tokyo',
      destinationTz: 'Asia/Tokyo',
    }],
    trip: TRIP,
  },
  files: [{ kind: 'pdf', mediaType: 'application/pdf', path: 'files/hotel-kanade-2p.pdf' }],
  expected: {
    facts: [
      { kind: 'window', what: 'Check-in 15:00 to 23:00', page: 1 },
      { kind: 'deadline', what: 'Check-out by 11:00', page: 1 },
      { kind: 'deadline', what: 'Free cancellation until 2026-11-12 18:00 Japan time (Asia/Tokyo from the document)', page: 1 },
      { kind: 'restriction', what: 'After that 100% of the first night charged', page: 1 },
      { kind: 'requirement', what: 'Passport at check-in for non-residents', page: 1 },
      { kind: 'requirement', what: 'The card used to book must be shown', page: 1 },
      { kind: 'cost_condition', what: 'Accommodation tax 200 yen per person per night, payable at the hotel', page: 1 },
      { kind: 'window', what: 'Reception open 07:00 to 23:00', page: 2 },
      { kind: 'requirement', what: 'Arrival after 23:00 must be notified by phone +81 75 000 0000', page: 2 },
      { kind: 'allowance', what: 'Breakfast 07:00 to 10:00 included for 2 guests', page: 2 },
      { kind: 'restriction', what: 'No luggage storage after check-out', page: 2 },
    ],
    skipped: ['The closing marketing paragraph on page 2 names no time, amount or action (prompt rule 3)'],
  },
};

const RYOKAN_FIXTURE = {
  id: 'ryokan-minato-text',
  trip: 'synthetic-kyoto',
  tripTitle: 'Kyoto in November (synthetic)',
  description: 'Short Japanese pasted-text ryokan confirmation with full-width digits in the check-in line, so NFKC matching is exercised.',
  bookingContext: {
    bookings: [{
      type: 'hotel',
      title: '旅館みなと',
      startDatetime: '2026-11-20T15:00',
      endDatetime: '2026-11-22T10:00',
      originTz: 'Asia/Tokyo',
      destinationTz: 'Asia/Tokyo',
    }],
    trip: TRIP,
  },
  files: [{ kind: 'text', mediaType: 'text/plain', path: 'files/ryokan-minato.txt' }],
  expected: {
    facts: [
      { kind: 'window', what: 'Check-in 15:00 to 19:00 (written with full-width digits)', page: 1 },
      { kind: 'deadline', what: 'Check-out 10:00', page: 1 },
      { kind: 'window', what: 'Dinner from 18:30', page: 1 },
      { kind: 'instruction', what: 'Phone the ryokan when arriving late', page: 1 },
      { kind: 'deadline', what: 'Free cancellation until 2026-11-17 (3 days before)', page: 1 },
      { kind: 'restriction', what: 'After that 100% of the stay charged', page: 1 },
      { kind: 'cost_condition', what: 'Bathing tax 150 yen per guest per night, paid locally', page: 1 },
    ],
    skipped: [],
  },
};

// ---------- render + verify -------------------------------------------------------------------

async function verifyHotelPdf(path) {
  const { pages, pageCount } = await extractPdfPages(readFileSync(path));
  if (pageCount !== 2) throw new Error(`${path}: ${pageCount} pages, expected 2`);
  const checks = [['15:00', 1], ['11:00', 1], ['¥200', 1], ['07:00', 2], ['+81 75 000 0000', 2], ['Luggage cannot be stored', 2]];
  for (const [quote, page] of checks) {
    const found = findQuote(pages, quote);
    if (!found.found || found.page !== page) {
      throw new Error(`${path}: expected "${quote}" on page ${page}, findQuote says ${JSON.stringify(found)}`);
    }
  }
  // The page-number test needs the two pages kept apart: nothing from page 2 may leak onto page 1.
  if (findQuote([pages[0]], '07:00').found) throw new Error(`${path}: "07:00" is on page 1`);
  return pageCount;
}

function parseArgs(argv) {
  const args = { chrome: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--chrome') args.chrome = argv[++i];
    else throw new Error(`unexpected argument ${argv[i]}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const chrome = findChrome(args);
  console.log(`chrome: ${chrome}`);
  mkdirSync(FILES_DIR, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'trippy-facts-render-'));
  try {
    const htmlPath = join(work, 'hotel-kanade-2p.html');
    writeFileSync(htmlPath, hotelHtml(), 'utf8');
    const pdfPath = join(FILES_DIR, 'hotel-kanade-2p.pdf');
    runChrome(chrome, join(work, 'profile'), ['--no-pdf-header-footer', `--print-to-pdf=${pdfPath}`], htmlPath, pdfPath);
    const pages = await verifyHotelPdf(pdfPath);
    console.log(`${pdfPath}  ${statSync(pdfPath).size} bytes  ${pages} pages, text layer verified`);

    writeFileSync(join(FILES_DIR, 'ryokan-minato.txt'), RYOKAN_TEXT, 'utf8');
    for (const fixture of [HOTEL_FIXTURE, RYOKAN_FIXTURE]) {
      const out = join(FIXTURE_DIR, `${fixture.id}.json`);
      writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
      console.log(out);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
