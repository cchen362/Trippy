// D-37-2 (Plan 37): no fact without its quote, and verification is recorded, not assumed — a quote is verified only against text Trippy extracted itself (a PDF's text layer or the pasted text); an image or a scanned PDF yields no text, so its facts are stored unverified ("read from image"). No OCR.
//
// This module must not import claude.js: claude.js imports normaliseForMatch from here to refuse a
// fact whose quote is empty once normalised.

import { createRequire } from 'node:module';
import { dirname } from 'node:path';

// pdfjs reads its data files with fs.readFile(<dir> + <name>) on Node, so each option is the package's
// own directory with a trailing slash. Without cMapUrl a CJK PDF that uses a predefined CMap (UniJIS,
// UniGB, ...) decodes to the wrong characters and its quotes could never verify; without
// standardFontDataUrl a PDF on the 14 standard fonts warns and loses their glyph data.
let pdfjsData = null;
function pdfjsDataOptions() {
  if (!pdfjsData) {
    const dir = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')).replace(/\\/g, '/');
    pdfjsData = Object.freeze({
      cMapUrl: `${dir}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${dir}/standard_fonts/`,
      wasmUrl: `${dir}/wasm/`,
    });
  }
  return pdfjsData;
}

// Zero-width characters a text layer or a pasted email can carry inside a word: ZWSP, ZWNJ, ZWJ,
// WORD JOINER, BOM / ZWNBSP.
const ZERO_WIDTH = /[​‌‍⁠﻿]/gu;
const WHITESPACE = /\s/gu;

// NFKC (full-width digits and letters, compatibility forms), then every whitespace character and
// every zero-width character removed, so line breaks, column gaps and ideographic spaces in a text
// layer never decide a match.
export function normaliseForMatch(s) {
  return String(s ?? '').normalize('NFKC').replace(WHITESPACE, '').replace(ZERO_WIDTH, '');
}

// pages: the document's text, one string per page (a text document is one page). Returns
// { found, page } with `page` 1-based: the page holding the quote, or for a quote that runs across a
// page break, the page it starts on. An empty quote is never found.
export function findQuote(pages, quote) {
  const needle = normaliseForMatch(quote);
  if (!needle || !Array.isArray(pages) || !pages.length) return { found: false, page: null };
  const normalised = pages.map(normaliseForMatch);
  const onPage = normalised.findIndex((p) => p.includes(needle));
  if (onPage !== -1) return { found: true, page: onPage + 1 };

  const joined = normalised.join('');
  const at = joined.indexOf(needle);
  if (at === -1) return { found: false, page: null };
  let end = 0;
  for (let i = 0; i < normalised.length; i += 1) {
    end += normalised[i].length;
    if (at < end) return { found: true, page: i + 1 };
  }
  return { found: true, page: normalised.length };
}

// pdfjs-dist's legacy build runs on Node without a canvas. In v6 the loading task owns the document's
// resources, so it is the task, not the document, that is destroyed.
export async function extractPdfPages(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, ...pdfjsDataOptions() });
  try {
    const doc = await task.promise;
    const pages = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => item.str + (item.hasEOL ? '\n' : '')).join(''));
      page.cleanup();
    }
    return { pages, pageCount: doc.numPages };
  } finally {
    await task.destroy();
  }
}

// The pages of a document as findQuote() wants them: a pasted text is one page (UTF-8 decoded), a PDF
// one string per page, an image has no text layer (null). A PDF pdfjs cannot open throws a plain
// Error; the caller records the failure and the document's facts stay unverified.
export async function documentTextPages({ kind, bytes }) {
  if (kind === 'text') return { pages: [Buffer.from(bytes).toString('utf8')] };
  if (kind === 'pdf') {
    try {
      const { pages } = await extractPdfPages(bytes);
      return { pages };
    } catch (err) {
      throw new Error(`pdfjs could not read the PDF (${err.message})`, { cause: err });
    }
  }
  return null;
}

// True when the pages hold anything findQuote can match (whitespace and zero-width characters removed),
// so a scanned PDF whose pages hold only blanks has no text layer.
export function hasTextLayer(pages) {
  return Array.isArray(pages) && pages.some((page) => normaliseForMatch(page).length > 0);
}
