// Plan 37 W0 — the text Trippy can extract from a document itself, in the harness.
//
// D-37-2 verifies a fact's quote against text Trippy extracted, never against what the model says it
// read: the PDF's text layer, or the pasted text. This is the harness copy (W1 moves the production
// one to src/services/documentText.js). A scanned PDF yields pages with no text and an image yields
// null; the callers record both as "no text layer", never as a pass.

import { normaliseForMatch } from './factsContract.mjs';

// pdfjs-dist's legacy build runs on Node without a canvas. In v6 the loading task owns the document's
// resources, so it is the task, not the document, that is destroyed.
export async function extractPdfPages(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false });
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

// The pages of a document as findQuote() wants them: a pasted text is one page, a PDF one string per
// page, an image has no text layer (null). A PDF pdfjs cannot open throws; the caller names the
// document and records the failure.
export async function documentPages(doc, content) {
  if (doc.kind === 'text') return { pages: [content.content], pageCount: 1 };
  if (doc.kind === 'pdf') {
    try {
      return await extractPdfPages(content.bytes);
    } catch (err) {
      throw new Error(`${doc.key}: pdfjs could not read the PDF (${err.message})`, { cause: err });
    }
  }
  return null;
}

// { pages, chars, hasText } — chars counts what findQuote can match (whitespace and zero-width
// characters removed), so a scanned PDF whose pages hold only blanks reports hasText false.
export function textLayerSummary(pages) {
  const chars = pages.reduce((total, page) => total + normaliseForMatch(page).length, 0);
  return { pages: pages.length, chars, hasText: chars > 0 };
}

// A census heuristic, not a verdict: which script dominates the text layer, so the grading sample can
// cover the languages present. Kana means Japanese, Hangul Korean, Han alone Chinese (a Japanese
// document with only kanji would be called Chinese), Latin letters latin, anything else unknown.
export function guessLanguage(text) {
  const s = String(text ?? '');
  if (/[぀-ヿ]/u.test(s)) return 'ja';
  if (/[가-힯ᄀ-ᇿ]/u.test(s)) return 'ko';
  if (/\p{Script=Han}/u.test(s)) return 'zh';
  if (/\p{Script=Latin}/u.test(s)) return 'latin';
  return 'unknown';
}
