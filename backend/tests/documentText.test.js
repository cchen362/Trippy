import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normaliseForMatch, findQuote, extractPdfPages, documentTextPages, hasTextLayer,
} from '../src/services/documentText.js';

// D-37-2 (Plan 37): a quote is verified only against text Trippy extracted itself. The PDFs are
// synthetic (a fictional hotel and ryokan) and rendered by scripts/renderDocumentTextFixtures.mjs
// (hotel-kanade-2p.pdf by scripts/modelEval/renderFactsFixtures.mjs).
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'documentText');
const fixture = (name) => readFileSync(join(FIXTURES, name));

describe('normaliseForMatch', () => {
  it('ignores whitespace, line breaks, ideographic spaces and zero-width characters', () => {
    expect(normaliseForMatch('Check-in \n from\u3000 15:00')).toBe('Check-infrom15:00');
    expect(normaliseForMatch('15\u200B:\u200C00\u2060\uFEFF')).toBe('15:00');
  });

  it('folds full-width forms to their half-width equivalents (NFKC)', () => {
    expect(normaliseForMatch('１５：００')).toBe('15:00');
    expect(normaliseForMatch('ＭＮ－７７３１')).toBe('MN-7731');
  });

  it('turns nothing and blanks into an empty string', () => {
    expect(normaliseForMatch(null)).toBe('');
    expect(normaliseForMatch(undefined)).toBe('');
    expect(normaliseForMatch(' \n\u3000\u200B')).toBe('');
  });
});

describe('findQuote', () => {
  const pages = ['Check-in from 15:00.\nReception opens at 07:00.', 'Breakfast is\nincluded for 2 guests.'];

  it('finds a quote on the page that holds it, whatever the line breaks', () => {
    expect(findQuote(pages, 'Check-in from 15:00.')).toEqual({ found: true, page: 1 });
    expect(findQuote(pages, 'Breakfast is included for 2 guests.')).toEqual({ found: true, page: 2 });
  });

  it('returns the page a quote starts on when it runs across a page break', () => {
    expect(findQuote(pages, 'opens at 07:00. Breakfast is included')).toEqual({ found: true, page: 1 });
  });

  it('never finds an empty quote, a blank one, or text that is not there', () => {
    expect(findQuote(pages, '')).toEqual({ found: false, page: null });
    expect(findQuote(pages, ' \n\u200B ')).toEqual({ found: false, page: null });
    expect(findQuote(pages, 'Free cancellation until Friday')).toEqual({ found: false, page: null });
  });

  it('finds nothing in no pages', () => {
    expect(findQuote([], '15:00')).toEqual({ found: false, page: null });
    expect(findQuote(null, '15:00')).toEqual({ found: false, page: null });
  });
});

describe('a text-layer PDF', () => {
  it('reads two pages and locates quotes on the page they are printed on', async () => {
    const result = await documentTextPages({ kind: 'pdf', bytes: fixture('hotel-kanade-2p.pdf') });
    expect(result.pages).toHaveLength(2);
    expect(hasTextLayer(result.pages)).toBe(true);
    expect(findQuote(result.pages, '15:00')).toEqual({ found: true, page: 1 });
    expect(findQuote(result.pages, 'Reception is open from 07:00 to 23:00.')).toEqual({ found: true, page: 2 });
  });

  it('returns the page a quote starts on when it spans the page break', async () => {
    const { pages } = await extractPdfPages(fixture('hotel-kanade-2p.pdf'));
    const lastOfPage1 = normaliseForMatch(pages[0]).slice(-12);
    const firstOfPage2 = normaliseForMatch(pages[1]).slice(0, 12);
    expect(findQuote(pages, `${lastOfPage1}${firstOfPage2}`)).toEqual({ found: true, page: 1 });
  });

  it('keeps pages apart: page 2 text is not on page 1', async () => {
    const { pages, pageCount } = await extractPdfPages(fixture('hotel-kanade-2p.pdf'));
    expect(pageCount).toBe(2);
    expect(findQuote([pages[0]], 'Reception is open from 07:00 to 23:00.').found).toBe(false);
  });
});

describe('a CJK PDF with a text layer', () => {
  it('verifies a half-width quote against full-width digits through NFKC', async () => {
    const { pages } = await documentTextPages({ kind: 'pdf', bytes: fixture('cjk-checkin.pdf') });
    expect(hasTextLayer(pages)).toBe(true);
    expect(findQuote(pages, 'チェックインは15:00から')).toEqual({ found: true, page: 1 });
    expect(findQuote(pages, 'チェックインは１５：００から')).toEqual({ found: true, page: 1 });
    expect(findQuote(pages, 'ご予約番号：MN-7731')).toEqual({ found: true, page: 1 });
    expect(findQuote(pages, '入湯税として1名様1泊150円')).toEqual({ found: true, page: 1 });
  });

  it('does not find a Japanese sentence the document does not contain', async () => {
    const { pages } = await documentTextPages({ kind: 'pdf', bytes: fixture('cjk-checkin.pdf') });
    expect(findQuote(pages, 'チェックインは16:00から').found).toBe(false);
  });
});

describe('a scanned-style PDF', () => {
  it('has pages but no text layer, and verifies nothing', async () => {
    const { pages } = await documentTextPages({ kind: 'pdf', bytes: fixture('scanned-checkin.pdf') });
    expect(pages.length).toBeGreaterThan(0);
    expect(hasTextLayer(pages)).toBe(false);
    expect(findQuote(pages, 'Check-in is available from 15:00 to 23:00.')).toEqual({ found: false, page: null });
  });
});

describe('documentTextPages', () => {
  it('has no text for an image', async () => {
    expect(await documentTextPages({ kind: 'image', bytes: fixture('checkin-screenshot.png') })).toBeNull();
  });

  it('treats pasted text as one verifiable page, UTF-8 decoded', async () => {
    const text = 'チェックイン：１５：００～１９：００\nキャンセル料：2026年11月17日まで無料です。';
    const result = await documentTextPages({ kind: 'text', bytes: Buffer.from(text, 'utf8') });
    expect(result.pages).toEqual([text]);
    expect(findQuote(result.pages, 'チェックイン：15:00～19:00')).toEqual({ found: true, page: 1 });
  });

  it('throws a plain Error naming the cause when pdfjs cannot open the PDF', async () => {
    const error = await documentTextPages({ kind: 'pdf', bytes: randomBytes(2048) }).catch((err) => err);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/^pdfjs could not read the PDF \(/);
    expect(error.cause).toBeInstanceOf(Error);
  });
});

describe('hasTextLayer', () => {
  it('is true only when some page holds something findQuote can match', () => {
    expect(hasTextLayer(['', ' \n\u200B'])).toBe(false);
    expect(hasTextLayer(['', 'a'])).toBe(true);
    expect(hasTextLayer([])).toBe(false);
    expect(hasTextLayer(null)).toBe(false);
  });
});
