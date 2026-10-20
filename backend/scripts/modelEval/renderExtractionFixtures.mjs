// Plan 30 W4 — render the synthetic text extraction fixtures as phone screenshots and PDFs.
//
//   cd backend; node scripts/modelEval/renderExtractionFixtures.mjs [--chrome <path-to-chrome-headless-shell>] [--only id,id]
//
// Plan 38 W0 adds the multi-file composites (COMPOSITES): fixtures that bundle several rendered
// files, with each expected booking carrying `filePositions` (0-based positions into `files`).
// They are assembled from the source fixtures' `expected` after the renders, never hand-copied.
// A render with `partOf` is one page of a booking split across screenshots and emits no fixture of
// its own; assertParts checks each page as a subset of the source and the pages together as a cover.
//
// No image or PDF had ever been run through extractBookings(), so the image path and the 5.5
// high-resolution image token cost were unmeasured. This turns eight of the committed text
// confirmations into:
//   - 1170x2532 PNG phone email screenshots (390x844 CSS px at device scale factor 3), and
//   - one-page A4 PDF e-tickets with real selectable text,
// and writes a fixture JSON beside each source fixture that points at the rendered file by `path`
// (resolved by extraction.mjs relative to fixtures/extraction/).
//
// Every fact is copied verbatim from the source fixture's text and only re-laid-out; nothing is
// added. assertFaithful() enforces that mechanically: each source token must appear in the page and
// every digit-bearing token on the page must appear in the source.
//
// Rendering uses the Chromium headless shell Playwright already installed (a child process; no npm
// dependency). Chrome path: --chrome <path>, else CHROME_PATH, else the newest
// %LOCALAPPDATA%\ms-playwright\chromium_headless_shell-*\chrome-headless-shell-win64 install.
// Re-runnable: outputs are overwritten, the page has a fixed 9:41 status-bar time and no clock.
// Chrome stamps its own creation date into each PDF's metadata, so PDF bytes are not byte-identical
// between runs; the page content is.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_DIR } from './lib/runner.mjs';
import { findChrome, runChrome } from './lib/chromium.mjs';

const FIXTURE_DIR = join(FIXTURES_DIR, 'extraction');
const FILES_DIR = join(FIXTURE_DIR, 'files');
const PNG_WIDTH = 1170;
const PNG_HEIGHT = 2532;

// ---------- html helpers ---------------------------------------------------------------------

const e = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const FONT_STACK = '"Segoe UI", "Microsoft YaHei", "Yu Gothic", "Malgun Gothic", sans-serif';

// iOS-style status bar: fixed time, signal bars, wifi, battery. Outside the facts region.
const STATUS_BAR = `
<div class="status">
  <span class="time">9:41</span>
  <span class="icons">
    <svg width="18" height="12" viewBox="0 0 18 12"><rect x="0" y="8" width="3" height="4" rx="0.8"/><rect x="5" y="5.5" width="3" height="6.5" rx="0.8"/><rect x="10" y="3" width="3" height="9" rx="0.8"/><rect x="15" y="0" width="3" height="12" rx="0.8"/></svg>
    <svg width="17" height="12" viewBox="0 0 17 12" fill="none" stroke="#111" stroke-width="1.8" stroke-linecap="round"><path d="M1.5 4.2a10 10 0 0 1 14 0"/><path d="M4 7a6.4 6.4 0 0 1 9 0"/><circle cx="8.5" cy="10" r="1.1" fill="#111" stroke="none"/></svg>
    <svg width="27" height="13" viewBox="0 0 27 13"><rect x="0.5" y="0.5" width="23" height="12" rx="3.5" fill="none" stroke="#111" opacity="0.4"/><rect x="2" y="2" width="20" height="9" rx="2.2" fill="#111"/><rect x="24.8" y="4.2" width="1.8" height="4.6" rx="0.9" fill="#111" opacity="0.5"/></svg>
  </span>
</div>`;

const PHONE_CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#fff}
body{width:390px;height:844px;overflow:hidden;position:relative;color:#1c1c1e;font-family:${FONT_STACK};-webkit-font-smoothing:antialiased}
.status{height:47px;display:flex;justify-content:space-between;align-items:flex-end;padding:0 30px 6px 34px}
.status .time{font-weight:600;font-size:16px;letter-spacing:-.2px}
.status .icons{display:flex;gap:6px;align-items:center}
.status svg{fill:#111;display:block}
.nav{height:38px;display:flex;align-items:center;justify-content:space-between;padding:0 14px;color:#0a6cdb;font-size:16px}
.nav .back{display:flex;align-items:center;gap:2px}
.nav .acts{display:flex;gap:18px}
.nav svg{display:block}
.head{padding:4px 16px 10px;border-bottom:1px solid #e3e3e6}
.subject{font-size:19px;font-weight:700;line-height:1.25;margin:0 0 9px}
.from{display:flex;align-items:center;gap:10px}
.avatar{width:36px;height:36px;border-radius:50%;color:#fff;font-weight:600;font-size:16px;display:flex;align-items:center;justify-content:center;flex:none}
.from .who{flex:1;line-height:1.2}
.from .name{font-size:15px;font-weight:600}
.from .to{font-size:12.5px;color:#6b6b70}
.from .when{font-size:12.5px;color:#6b6b70;align-self:flex-start;margin-top:3px}
.body{padding:0}
.band{padding:13px 16px;color:#fff}
.band .brand{font-size:19px;font-weight:700;letter-spacing:.2px}
.band .sub{font-size:12.5px;opacity:.9;margin-top:2px}
.pad{padding:12px 16px}
.refbox{border:1.5px dashed #b9b9bf;border-radius:8px;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.lbl{font-size:11px;letter-spacing:.7px;text-transform:uppercase;color:#76767c}
.ref{font-family:Consolas,"Courier New",monospace;font-size:21px;font-weight:700;letter-spacing:1.5px}
.row{display:flex;justify-content:space-between;align-items:baseline;padding:8px 0;border-bottom:1px solid #ececef;gap:12px}
.row:last-child{border-bottom:0}
.row .k{font-size:12.5px;color:#76767c;flex:none}
.row .v{font-size:15px;font-weight:600;text-align:right}
.flightno{font-size:25px;font-weight:700;letter-spacing:.3px;margin:2px 0 8px}
.leg{border:1px solid #e3e3e6;border-radius:10px;padding:10px 12px;margin-bottom:10px}
.leg .top{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px}
.leg .tag{font-size:11px;letter-spacing:1px;font-weight:700}
.leg .no{font-size:19px;font-weight:700}
.leg .route{font-size:14px;font-weight:600;margin-bottom:6px}
.leg .times{display:flex;gap:10px;font-size:13px}
.leg .times div{flex:1;line-height:1.35}
.leg .times .t{font-size:17px;font-weight:700;display:block}
.stop{display:flex;gap:12px;margin:4px 0 0}
.stop .tl{width:14px;display:flex;flex-direction:column;align-items:center;padding-top:6px}
.stop .dot{width:11px;height:11px;border-radius:50%;border:2.5px solid var(--c);background:#fff;flex:none}
.stop .line{flex:1;width:2px;background:var(--c);opacity:.35;margin:2px 0}
.stop .info{flex:1;padding-bottom:12px}
.stop .place{font-size:16px;font-weight:600}
.stop .meta{font-size:13px;color:#555}
.stop .tm{font-size:24px;font-weight:700;line-height:1.15}
.note{font-size:13.5px;color:#444;margin-top:8px}
.prose{font-size:16px;line-height:1.5;padding:14px 16px}
.prose p{margin:0 0 12px}
`;

function phonePage({ lang = 'en', title, sender, initial, avatarColor, subject, body }) {
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=390"><title>${e(title)}</title>
<style>${PHONE_CSS}</style></head><body>
${STATUS_BAR}
<div class="nav">
  <span class="back"><svg width="12" height="20" viewBox="0 0 12 20" fill="none" stroke="#0a6cdb" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2 2 10l8 8"/></svg>Inbox</span>
  <span class="acts">
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0a6cdb" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v1H3z"/><path d="M4 8v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0a6cdb" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16v12H4z"/><path d="m4 7 8 6 8-6"/></svg>
  </span>
</div>
<!--facts-->
<div class="head">
  <h1 class="subject">${e(subject)}</h1>
  <div class="from">
    <div class="avatar" style="background:${avatarColor}">${e(initial)}</div>
    <div class="who"><div class="name">${e(sender)}</div><div class="to">to me</div></div>
    <div class="when">Yesterday</div>
  </div>
</div>
<div class="body">
${body}
</div>
<!--/facts-->
</body></html>`;
}

const PDF_CSS = `
@page{size:A4;margin:18mm 18mm 18mm 18mm}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:${FONT_STACK};color:#1d2430;font-size:11pt;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.top{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid var(--c);padding-bottom:10px;margin-bottom:22px}
.top .brand{font-size:26pt;font-weight:800;color:var(--c);letter-spacing:.5px}
.top .doc{font-size:12pt;font-weight:600;text-align:right}
h1{font-size:19pt;margin:0 0 16px}
.refbox{border:2px solid var(--c);border-radius:6px;padding:12px 16px;display:inline-block;margin-bottom:24px}
.refbox .lbl{font-size:8.5pt;letter-spacing:1px;text-transform:uppercase;color:#5b6573}
.refbox .ref{font-family:Consolas,"Courier New",monospace;font-size:24pt;font-weight:700;letter-spacing:2px}
table{width:100%;border-collapse:collapse;margin-bottom:18px}
th{background:#eef1f5;text-align:left;font-size:8.5pt;letter-spacing:.8px;text-transform:uppercase;color:#5b6573;padding:8px 10px;border-bottom:1px solid #c9d0da}
td{padding:11px 10px;border-bottom:1px solid #dde2ea;vertical-align:top}
tr.group td{background:var(--c);color:#fff;font-weight:700;padding:7px 10px;letter-spacing:.3px}
td.flight{font-weight:700;font-size:13pt;white-space:nowrap}
td .place{font-weight:600}
td .tm{font-size:15pt;font-weight:700;display:block}
.detail{margin-top:6px;font-size:11.5pt;font-weight:600}
.facts td:first-child{width:34%;color:#5b6573}
.facts tr.group td:first-child{color:#fff}
.facts td.flight:first-child{color:#1d2430}
`;

function pdfPage({ lang = 'en', title, color, body }) {
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><title>${e(title)}</title>
<style>${PDF_CSS}</style></head><body style="--c:${color}">
<!--facts-->
${body}
<!--/facts-->
</body></html>`;
}

// ---------- the eight renders ----------------------------------------------------------------

const refRow = (label, value) =>
  `<div class="refbox"><span class="lbl">${e(label)}</span><span class="ref">${e(value)}</span></div>`;
const kv = (k, v) => `<div class="row"><span class="k">${e(k)}</span><span class="v">${e(v)}</span></div>`;
const band = (color, brand, sub = '') =>
  `<div class="band" style="background:${color}"><div class="brand">${e(brand)}</div>${sub ? `<div class="sub">${e(sub)}</div>` : ''}</div>`;
const stop = (color, label, place, meta, date, time) => `
<div class="stop" style="--c:${color}"><div class="tl"><span class="dot"></span>${label === 'Departs' ? '<span class="line"></span>' : ''}</div>
<div class="info"><div class="lbl">${e(label)}</div><div class="place">${e(place)}</div><div class="meta">${e(meta)}</div>
<div class="meta">${e(date)}</div><div class="tm">${e(time)}</div></div></div>`;
const leg = (color, tag, no, route, d1, t1, d2, t2) => `
<div class="leg"><div class="top"><span class="tag" style="color:${color}">${e(tag)}</span><span class="no">${e(no)}</span></div>
<div class="route">${e(route)}</div>
<div class="times"><div>${e(d1)}<span class="t">${e(t1)}</span></div><div>${e(d2)}<span class="t">${e(t2)}</span></div></div></div>`;

const RENDERS = [
  {
    id: 'img-overnight-flight-lands-next-day',
    source: 'overnight-flight-lands-next-day',
    kind: 'image',
    html: () => phonePage({
      title: 'Singapore Airlines - Booking Reference: 9RB4TX',
      sender: 'Singapore Airlines', initial: 'S', avatarColor: '#1d3b6e',
      subject: 'Singapore Airlines - Booking Reference: 9RB4TX',
      body: `${band('#1d3b6e', 'Singapore Airlines')}
<div class="pad">
${refRow('Booking Reference', '9RB4TX')}
<div class="flightno">SQ 322</div>
${stop('#1d3b6e', 'Departs', 'Singapore (SIN)', 'Changi Terminal 3', 'Fri 12 Mar 2027', '23:55')}
${stop('#1d3b6e', 'Arrives', 'London (LHR)', 'Heathrow Terminal 2', 'Sat 13 Mar 2027', '06:20')}
<div class="note">Seat 41A confirmed.</div>
</div>`,
    }),
  },
  {
    id: 'img-cjk-high-speed-train',
    source: 'cjk-high-speed-train',
    kind: 'image',
    html: () => phonePage({
      lang: 'zh-CN',
      title: '【12306】订票成功',
      sender: '12306', initial: '1', avatarColor: '#c8231f',
      subject: '【12306】订票成功',
      body: `${band('#c8231f', '【12306】订票成功')}
<div class="pad">
${kv('订单号', 'EA71234567')}
${kv('乘车日期', '2027年05月03日')}
<div class="flightno" style="margin-top:14px">G8501次</div>
${stop('#c8231f', '出发', '成都东站', '', '', '09:12开')}
${stop('#c8231f', '到达', '重庆西站', '', '', '10:41到')}
${kv('席别', '二等座')}
${kv('车厢', '06车')}
${kv('座位号', '11C')}
<div class="note">请凭本人有效身份证件原件进站乘车。</div>
</div>`,
    }),
  },
  {
    id: 'img-cjk-ryokan-japan',
    source: 'cjk-ryokan-japan',
    kind: 'image',
    html: () => phonePage({
      lang: 'ja',
      title: 'ご予約確認書',
      sender: '旅館 山水荘', initial: '山', avatarColor: '#5b4636',
      subject: 'ご予約確認書',
      body: `${band('#5b4636', 'ご予約確認書')}
<div class="pad">
${kv('宿泊施設', '旅館 山水荘')}
${kv('所在地', '京都市東山区清水三丁目')}
${kv('チェックイン', '2027年11月8日 15:00')}
${kv('チェックアウト', '2027年11月10日 10:00')}
${kv('ご宿泊', '2泊（2名様・和室）')}
${kv('予約番号', 'KY-88213')}
<div class="note" style="margin-top:16px">ご来館をお待ちしております。</div>
</div>`,
    }),
  },
  {
    id: 'img-multi-leg-outbound-connection-return',
    source: 'multi-leg-outbound-connection-return',
    kind: 'image',
    html: () => phonePage({
      title: 'Korean Air - Itinerary Receipt',
      sender: 'Korean Air', initial: 'K', avatarColor: '#00256c',
      subject: 'Korean Air - Itinerary Receipt',
      body: `${band('#00256c', 'Korean Air', 'Itinerary Receipt')}
<div class="pad" style="padding-top:10px">
${refRow('Booking reference', 'T5HN8V')}
${leg('#00256c', 'OUTBOUND', 'KE 012', 'Los Angeles (LAX) → Seoul Incheon (ICN)', 'Mon 04 OCT 2027', '11:30', 'Tue 05 OCT 2027', '16:30')}
${leg('#00256c', 'CONNECTION', 'KE 893', 'Seoul Incheon (ICN) → Chengdu Tianfu (TFU)', 'Tue 05 OCT 2027', '19:30', 'Tue 05 OCT 2027', '22:20')}
${leg('#00256c', 'RETURN', 'KE 894', 'Chengdu Tianfu (TFU) → Los Angeles (LAX)', 'Tue 19 OCT 2027', '14:10', 'Tue 19 OCT 2027', '11:10')}
<div class="note" style="margin-top:2px">All times are local to the airport.</div>
</div>`,
    }),
  },
  {
    id: 'img-dmy-in-trip-mdy-wins',
    source: 'dmy-in-trip-mdy-wins',
    kind: 'image',
    html: () => phonePage({
      title: 'United Airlines - Your trip confirmation',
      sender: 'United Airlines', initial: 'U', avatarColor: '#1b4f9c',
      subject: 'Your trip confirmation',
      body: `${band('#1b4f9c', 'United Airlines', 'Your trip confirmation')}
<div class="pad">
${refRow('Confirmation number', 'KQ7M2D')}
<div class="flightno">Flight UA 837</div>
${stop('#1b4f9c', 'Departs', 'San Francisco (SFO)', '', '04/05/2027', '11:25')}
${stop('#1b4f9c', 'Arrives', 'Tokyo Haneda (HND)', '', '04/06/2027', '15:05')}
${kv('Cabin', 'Economy Plus')}
<div class="note" style="margin-top:12px">Thank you for choosing United.</div>
</div>`,
    }),
  },
  {
    id: 'img-non-travel-dinner-invite',
    source: 'non-travel-dinner-invite',
    kind: 'image',
    html: () => phonePage({
      title: 'Dinner at ours',
      sender: 'Sam', initial: 'S', avatarColor: '#8a6fb0',
      subject: 'Dinner at ours',
      body: `<div class="prose">
<p>Hi all!</p>
<p>Dinner at ours on Saturday 17 April at 7:30pm. <span style="white-space:nowrap">14 Elm Grove, Bristol.</span><br>Bring a bottle if you like. I am doing a big pot of chilli, veggie option too.<br>Let me know by Thursday if you can come.</p>
<p>Sam</p>
</div>`,
    }),
  },
  {
    id: 'pdf-round-trip-single-email',
    source: 'round-trip-single-email',
    kind: 'pdf',
    html: () => pdfPage({
      title: 'KLM - Your booking is confirmed',
      color: '#00a1de',
      body: `<div class="top"><span class="brand">KLM</span><span class="doc">Your booking is confirmed</span></div>
<div class="refbox"><div class="lbl">Booking code</div><div class="ref">PX2K6C</div></div>
<table>
<tr><th>Flight</th><th>Departure</th><th>Arrival</th></tr>
<tr class="group"><td colspan="3">Outbound &nbsp; Fri 10 Sep 2027</td></tr>
<tr><td class="flight">KL 1675</td><td><span class="place">Amsterdam (AMS)</span><span class="tm">09:05</span></td><td><span class="place">Barcelona (BCN)</span><span class="tm">11:10</span></td></tr>
<tr class="group"><td colspan="3">Return &nbsp; Tue 14 Sep 2027</td></tr>
<tr><td class="flight">KL 1676</td><td><span class="place">Barcelona (BCN)</span><span class="tm">18:30</span></td><td><span class="place">Amsterdam (AMS)</span><span class="tm">20:45</span></td></tr>
</table>`,
    }),
  },
  {
    id: 'pdf-german-train-dotted-date',
    source: 'german-train-dotted-date',
    kind: 'pdf',
    html: () => pdfPage({
      lang: 'de',
      title: 'Ihre Buchungsbestätigung',
      color: '#c50014',
      body: `<div class="top"><span class="brand">Ihre Buchungsbestätigung</span></div>
<div class="refbox"><div class="lbl">Auftragsnummer</div><div class="ref">7GH2KP</div></div>
<table>
<tr class="group"><td colspan="3">Hinfahrt am Sa, 21.08.27</td></tr>
<tr><th>Halt</th><th></th><th>Zeit</th></tr>
<tr><td class="place">Berlin Hbf</td><td>ab</td><td><span class="tm">08:00</span></td></tr>
<tr><td class="place">München Hbf</td><td>an</td><td><span class="tm">12:05</span></td></tr>
</table>
<div class="detail">ICE 1005</div>
<div class="detail">2. Klasse, Wagen 25, Platz 61 (Fenster)</div>`,
    }),
  },
  // Plan 38 W0: renders that exist so the multi-file composites below have enough different files.
  {
    id: 'img-hotel-dates-only-explicit-year',
    source: 'hotel-dates-only-explicit-year',
    kind: 'image',
    html: () => phonePage({
      title: 'Your stay at Karakoy Residence is confirmed',
      sender: 'Karakoy Residence', initial: 'K', avatarColor: '#0f6b5c',
      subject: 'Your stay at Karakoy Residence is confirmed',
      body: `${band('#0f6b5c', 'Karakoy Residence')}
<div class="pad">
${kv('Check-in', 'Friday, 8 October 2027')}
${kv('Check-out', 'Monday, 11 October 2027')}
${kv('Guests', '2 adults')}
${kv('Reservation number', 'HRX-4471902')}
${kv('Address', 'Kemankes Caddesi 33, Karakoy, Istanbul')}
</div>`,
    }),
  },
  {
    id: 'img-flight-number-leading-zeros',
    source: 'flight-number-leading-zeros',
    kind: 'image',
    html: () => phonePage({
      title: 'Your trip is confirmed',
      sender: 'Reservations', initial: 'R', avatarColor: '#3a5a40',
      subject: 'Your trip is confirmed',
      body: `${band('#3a5a40', 'Your trip is confirmed')}
<div class="pad">
${refRow('Reservation code', 'R7T4PL')}
<div class="flightno">Flight KE0012</div>
${kv('Route', 'Seoul Incheon (ICN) → Singapore Changi (SIN)')}
${kv('Departs', 'Tue 02 Mar 2027 at 09:15')}
${kv('Arrives', 'Tue 02 Mar 2027 at 15:05')}
<div class="note" style="margin-top:12px">Baggage: 1 piece, 23 kg. Meals served on board.</div>
</div>`,
    }),
  },
  // One booking split across two screenshots (Plan 38 W0 fixture c). Neither half is a valid
  // single-file fixture on its own, so `fixture: false`; the group is checked together (PART_GROUPS).
  {
    id: 'img-hotel-confirmation-split-p1',
    source: 'hotel-confirmation-split',
    kind: 'image',
    partOf: 'hotel-confirmation-split',
    fixture: false,
    html: () => phonePage({
      title: 'Your reservation is confirmed',
      sender: 'Reservations', initial: 'R', avatarColor: '#7a3b2e',
      subject: 'Your reservation is confirmed',
      body: `${band('#7a3b2e', 'Hotel Casa do Rio Porto')}
<div class="pad">
${kv('Check-in', 'Tuesday, 14 September 2027, from 15:00')}
${kv('Check-out', 'Friday, 17 September 2027, until 11:00')}
</div>`,
    }),
  },
  {
    id: 'img-hotel-confirmation-split-p2',
    source: 'hotel-confirmation-split',
    kind: 'image',
    partOf: 'hotel-confirmation-split',
    fixture: false,
    html: () => phonePage({
      title: 'Your reservation is confirmed',
      sender: 'Reservations', initial: 'R', avatarColor: '#7a3b2e',
      subject: 'Your reservation is confirmed',
      body: `<div class="pad">
${refRow('Confirmation number', '7731845026')}
${kv('Address', 'Rua das Flores 88, Porto')}
${kv('Room', 'Deluxe Double, 1 room, 2 guests')}
</div>`,
    }),
  },
  {
    id: 'pdf-itinerary-flight-train-two-hotels',
    source: 'itinerary-flight-train-two-hotels',
    kind: 'pdf',
    html: () => pdfPage({
      title: 'Meridian Travel - Your itinerary',
      color: '#2f5d62',
      body: `<div class="top"><span class="brand">Meridian Travel</span><span class="doc">Your itinerary</span></div>
<div class="refbox"><div class="lbl">File reference</div><div class="ref">MT-58213</div></div>
<table class="facts">
<tr class="group"><td colspan="3">FLIGHT &nbsp; Fri 05 Nov 2027</td></tr>
<tr><td class="flight">TP 1359</td><td><span class="place">Zurich (ZRH)</span><span class="tm">07:20</span></td><td><span class="place">Lisbon (LIS)</span><span class="tm">09:40</span></td></tr>
<tr><td>Airline reference</td><td colspan="2"><b>QW7R3N</b></td></tr>
<tr class="group"><td colspan="3">HOTEL &nbsp; Hotel Alfama Mar, Rua dos Remedios 41, Lisbon</td></tr>
<tr><td>Check-in</td><td colspan="2">Fri 05 Nov 2027 from 15:00</td></tr>
<tr><td>Check-out</td><td colspan="2">Mon 08 Nov 2027 until 11:00</td></tr>
<tr><td>Hotel confirmation</td><td colspan="2"><b>LX-90417</b></td></tr>
<tr class="group"><td colspan="3">TRAIN &nbsp; Mon 08 Nov 2027</td></tr>
<tr><td class="flight">Alfa Pendular</td><td><span class="place">Lisbon Santa Apolonia</span><span class="tm">12:30</span></td><td><span class="place">Porto Campanha</span><span class="tm">15:10</span></td></tr>
<tr><td>Train reservation</td><td colspan="2"><b>4402917, Coach 3, Seat 14</b></td></tr>
<tr class="group"><td colspan="3">HOTEL &nbsp; Hotel Ribeira Douro, Cais da Estiva 17, Porto</td></tr>
<tr><td>Check-in</td><td colspan="2">Mon 08 Nov 2027 from 15:00</td></tr>
<tr><td>Check-out</td><td colspan="2">Thu 11 Nov 2027 until 11:00</td></tr>
<tr><td>Hotel confirmation</td><td colspan="2"><b>PT-62850</b></td></tr>
</table>`,
    }),
  },
];

// Renders that are parts of one source: id of the source -> the part renders (Plan 38 W0).
const PART_GROUPS = new Map();
for (const r of RENDERS) {
  if (r.partOf) PART_GROUPS.set(r.partOf, [...(PART_GROUPS.get(r.partOf) ?? []), r]);
}

// ---------- composite multi-file fixtures (Plan 38 W0) -----------------------------------------
//
// Each composite is assembled from the source fixtures' own `expected`, so it cannot drift from
// them: `bookings` lists, in the answer order, which source booking each expected entry is and
// which of the composite's `files` it came from (0-based `filePositions`). `files` entries are a
// rendered file (`render`, an id under files/) or a source text fixture pasted inline (`text`).
// tripContext is null on every composite: all the sources print explicit full dates (with the year)
// and state their own cities, so none of their expected values depends on a trip range. A source
// whose own fixture carries a tripContext (the Istanbul hotel, the ryokan, the overnight flight, the
// round trip) only echoes destinations the text already names.
const COMPOSITES = [
  {
    id: 'multi-four-screenshots-two-hotels-two-flights',
    description: 'Four phone screenshots (two hotels, two flights) in one import; the files are in an order unlike the date order of the bookings, so each booking must name its own file.',
    files: [
      { render: 'img-hotel-dates-only-explicit-year' },
      { render: 'img-overnight-flight-lands-next-day' },
      { render: 'img-cjk-ryokan-japan' },
      { render: 'img-flight-number-leading-zeros' },
    ],
    bookings: [
      { source: 'flight-number-leading-zeros', index: 0, filePositions: [3] },
      { source: 'overnight-flight-lands-next-day', index: 0, filePositions: [1] },
      { source: 'hotel-dates-only-explicit-year', index: 0, filePositions: [0] },
      { source: 'cjk-ryokan-japan', index: 0, filePositions: [2] },
    ],
  },
  {
    id: 'multi-round-trip-pdf-plus-hotel-image',
    description: 'A round-trip e-ticket PDF (two flights, one file) plus an unrelated hotel screenshot: both flights name the PDF only, the hotel the screenshot only.',
    files: [
      { render: 'pdf-round-trip-single-email' },
      { render: 'img-hotel-dates-only-explicit-year' },
    ],
    bookings: [
      { source: 'round-trip-single-email', index: 0, filePositions: [0] },
      { source: 'round-trip-single-email', index: 1, filePositions: [0] },
      { source: 'hotel-dates-only-explicit-year', index: 0, filePositions: [1] },
    ],
  },
  {
    id: 'multi-one-hotel-two-screenshots',
    description: 'One hotel booking split across two page screenshots (name and dates on the first; confirmation number, address and room on the second): one booking naming both files.',
    files: [
      { render: 'img-hotel-confirmation-split-p1' },
      { render: 'img-hotel-confirmation-split-p2' },
    ],
    bookings: [
      { source: 'hotel-confirmation-split', index: 0, filePositions: [0, 1] },
    ],
  },
  {
    id: 'multi-pasted-text-plus-image',
    description: 'Pasted flight confirmation text plus an unrelated hotel screenshot: each booking names its own input.',
    files: [
      { text: 'flight-number-suffix-letter' },
      { render: 'img-hotel-dates-only-explicit-year' },
    ],
    bookings: [
      { source: 'flight-number-suffix-letter', index: 0, filePositions: [0] },
      { source: 'hotel-dates-only-explicit-year', index: 0, filePositions: [1] },
    ],
  },
  {
    id: 'multi-itinerary-pdf-plus-hotel-image',
    description: 'One agency itinerary PDF holding a flight, a train and two hotels, uploaded with one unrelated hotel screenshot: the four itinerary bookings each name the PDF only, the screenshot hotel names the screenshot only.',
    files: [
      { render: 'pdf-itinerary-flight-train-two-hotels' },
      { render: 'img-cjk-ryokan-japan' },
    ],
    bookings: [
      { source: 'itinerary-flight-train-two-hotels', index: 0, filePositions: [0] },
      { source: 'itinerary-flight-train-two-hotels', index: 1, filePositions: [0] },
      { source: 'itinerary-flight-train-two-hotels', index: 2, filePositions: [0] },
      { source: 'itinerary-flight-train-two-hotels', index: 3, filePositions: [0] },
      { source: 'cjk-ryokan-japan', index: 0, filePositions: [1] },
    ],
  },
];

// ---------- fidelity guard -------------------------------------------------------------------

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&nbsp;': ' ' };

function pageText(html) {
  const region = html.split('<!--facts-->')[1].split('<!--/facts-->')[0];
  return region
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<br\s*\/?>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|lt|gt|quot|nbsp);/g, (m) => ENTITIES[m]);
}

// Drops the punctuation that layout legitimately changes (label colons, arrows, dashes between
// words), keeps everything else character for character.
const squash = (s) => s.replace(/[:：→]|->|\s-\s/g, ' ').replace(/\s+/g, '');
const tokens = (s) => s.replace(/[:：→]|->|\s-\s/g, ' ').split(/\s+/).map((t) => t.replace(/^[,.;]+|[,.;]+$/g, '')).filter(Boolean);

// Every digit-bearing token on one page must appear in the source (nothing invented).
function assertSubset(id, sourceText, html) {
  const sourceSquashed = squash(sourceText);
  const added = tokens(pageText(html)).filter((t) => /\d/.test(t) && !sourceSquashed.includes(squash(t)));
  if (added.length) throw new Error(`${id}: digit-bearing text not in the source: ${added.join(' | ')}`);
}

// Every source token must appear somewhere across the given pages (nothing dropped).
function assertCoverage(id, sourceText, htmls) {
  const pagesSquashed = squash(htmls.map(pageText).join(' '));
  const missing = tokens(sourceText).filter((t) => !pagesSquashed.includes(squash(t)));
  if (missing.length) throw new Error(`${id}: source facts missing from the page(s): ${missing.join(' | ')}`);
}

function assertFaithful(render, sourceText, html) {
  assertCoverage(render.id, sourceText, [html]);
  assertSubset(render.id, sourceText, html);
}

// Plan 38 W0: a source rendered as several screenshots. Each part is checked as a subset of the
// source (no invented digit-bearing text); together the parts must cover every source token.
function assertParts(groupId, sourceText, parts) {
  const htmls = parts.map((r) => r.html());
  parts.forEach((r, i) => assertSubset(r.id, sourceText, htmls[i]));
  assertCoverage(groupId, sourceText, htmls);
}

// ---------- main -----------------------------------------------------------------------------

function pngSize(path) {
  const b = readFileSync(path);
  if (b.length < 24 || b.toString('latin1', 1, 4) !== 'PNG') throw new Error(`${path} is not a PNG`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function pdfPages(path) {
  const text = readFileSync(path).toString('latin1');
  if (!text.startsWith('%PDF')) throw new Error(`${path} is not a PDF`);
  return (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

function parseArgs(argv) {
  const args = { chrome: null, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--chrome') args.chrome = argv[++i];
    else if (argv[i] === '--only') args.only = new Set(argv[++i].split(',').map((s) => s.trim()));
    else throw new Error(`unexpected argument ${argv[i]}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const chrome = findChrome(args);
  console.log(`chrome: ${chrome}`);
  mkdirSync(FILES_DIR, { recursive: true });
  for (const [groupId, parts] of PART_GROUPS) {
    const source = JSON.parse(readFileSync(join(FIXTURE_DIR, `${groupId}.json`), 'utf8'));
    assertParts(groupId, source.files.map((f) => f.content).join('\n'), parts);
  }
  const work = mkdtempSync(join(tmpdir(), 'trippy-extraction-render-'));

  try {
    for (const render of RENDERS) {
      if (args.only && !args.only.has(render.id)) continue;
      const source = JSON.parse(readFileSync(join(FIXTURE_DIR, `${render.source}.json`), 'utf8'));
      const sourceText = source.files.map((f) => f.content).join('\n');

      const html = render.html();
      if (render.partOf) assertSubset(render.id, sourceText, html);
      else assertFaithful(render, sourceText, html);
      const htmlPath = join(work, `${render.id}.html`);
      writeFileSync(htmlPath, html, 'utf8');

      const ext = render.kind === 'image' ? 'png' : 'pdf';
      const outPath = join(FILES_DIR, `${render.id}.${ext}`);
      const profileDir = join(work, `profile-${render.id}`);
      if (render.kind === 'image') {
        runChrome(chrome, profileDir,
          ['--force-device-scale-factor=3', '--window-size=390,844', '--hide-scrollbars', `--screenshot=${outPath}`],
          htmlPath, outPath);
        const { width, height } = pngSize(outPath);
        if (width !== PNG_WIDTH || height !== PNG_HEIGHT) {
          throw new Error(`${render.id}: PNG is ${width}x${height}, expected ${PNG_WIDTH}x${PNG_HEIGHT}`);
        }
        console.log(`${outPath}  ${statSync(outPath).size} bytes  ${width}x${height}`);
      } else {
        runChrome(chrome, profileDir, ['--no-pdf-header-footer', `--print-to-pdf=${outPath}`], htmlPath, outPath);
        const pages = pdfPages(outPath);
        if (pages < 1 || pages > 2) throw new Error(`${render.id}: PDF has ${pages} pages, expected 1-2`);
        console.log(`${outPath}  ${statSync(outPath).size} bytes  ${pages} page(s)`);
      }

      if (render.fixture === false) continue;
      const fixture = {
        id: render.id,
        description: `${render.kind} render of ${source.id}: ${source.description}`,
        tags: [...source.tags, render.kind === 'image' ? 'image' : 'pdf', 'rendered'],
        source: source.id,
        tripContext: source.tripContext,
        contextText: source.contextText,
        files: [render.kind === 'image'
          ? { kind: 'image', mediaType: 'image/png', path: `files/${render.id}.png` }
          : { kind: 'pdf', mediaType: 'application/pdf', path: `files/${render.id}.pdf` }],
        expected: source.expected,
      };
      writeFileSync(join(FIXTURE_DIR, `${render.id}.json`), `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  for (const composite of COMPOSITES) {
    if (args.only && !args.only.has(composite.id)) continue;
    writeComposite(composite);
  }
}

// ---------- composites -----------------------------------------------------------------------

function loadSource(id) {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${id}.json`), 'utf8'));
}

function compositeFile(entry) {
  if (entry.text) {
    const source = loadSource(entry.text);
    if (source.files.length !== 1 || source.files[0].kind !== 'text') throw new Error(`${entry.text}: not a one-file text fixture`);
    return { kind: 'text', content: source.files[0].content };
  }
  const ext = ['png', 'pdf'].find((x) => existsSync(join(FILES_DIR, `${entry.render}.${x}`)));
  if (!ext) throw new Error(`composite file files/${entry.render} does not exist; run the renderer first`);
  const rel = `files/${entry.render}.${ext}`;
  return ext === 'png'
    ? { kind: 'image', mediaType: 'image/png', path: rel }
    : { kind: 'pdf', mediaType: 'application/pdf', path: rel };
}

function writeComposite(composite) {
  const files = composite.files.map(compositeFile);
  const bookings = composite.bookings.map((b) => {
    const expected = loadSource(b.source).expected.bookings[b.index];
    if (!expected) throw new Error(`${composite.id}: ${b.source} has no booking ${b.index}`);
    const sorted = [...new Set(b.filePositions)].sort((x, y) => x - y);
    if (sorted.length !== b.filePositions.length || sorted.some((pos, i) => pos !== b.filePositions[i])) {
      throw new Error(`${composite.id}: filePositions must be sorted and unique`);
    }
    if (sorted.some((pos) => !Number.isInteger(pos) || pos < 0 || pos >= files.length)) {
      throw new Error(`${composite.id}: filePositions ${JSON.stringify(b.filePositions)} out of range for ${files.length} files`);
    }
    return { ...structuredClone(expected), filePositions: b.filePositions };
  });
  const fixture = {
    id: composite.id,
    description: composite.description,
    tags: ['multi-file', 'rendered'],
    source: [...new Set(composite.bookings.map((b) => b.source))].join(', '),
    tripContext: null,
    contextText: null,
    files,
    expected: { isTravelRelated: true, kind: 'bookings', bookings },
  };
  writeFileSync(join(FIXTURE_DIR, `${composite.id}.json`), `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  console.log(`${composite.id}: ${files.length} files, ${bookings.length} bookings`);
}

main();
