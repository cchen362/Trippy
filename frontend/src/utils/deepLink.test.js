import { describe, expect, it } from 'vitest';
import { buildDeepLink } from './deepLink.js';

// Plan 24 W3 (F2) — buildDeepLink previously had ZERO direct coverage.
// Review §10 "New frontend unit — deepLink.test.js" is the normative list;
// cases below are numbered to match that list. Cases 7-12 are the five
// branches inherited from the deleted backend twin (backend/tests/map.test.js:95-119,
// deleted in W2) plus the empty-string-ID case, per the F2 correction note.
describe('buildDeepLink', () => {
  // Review §10 case 1
  it('google + valid ID: full URL with query before query_place_id', () => {
    const url = buildDeepLink('google', 29.560110, 106.573357, 'People\'s Liberation Monument', 'abc123');
    expect(url).toBe('https://www.google.com/maps/search/?api=1&query=29.56011,106.573357&query_place_id=abc123');
    expect(url.indexOf('query=')).toBeLessThan(url.indexOf('query_place_id='));
  });

  // Review §10 case 2 — D-24-5 no-regression anchor: query is always present,
  // byte-for-byte identical to today's URL when there is no place ID.
  it('google + null ID: byte-for-byte the no-regression anchor URL', () => {
    const url = buildDeepLink('google', 29.560110, 106.573357, 'People\'s Liberation Monument', null);
    expect(url).toBe('https://www.google.com/maps/search/?api=1&query=29.56011,106.573357');
  });

  // Review §10 case 3 / §5 row 14 — amap never emits query_place_id or the ID.
  it('amap + ID supplied: full amap URL, no query_place_id and no ID leakage', () => {
    const url = buildDeepLink('amap', 29.560110, 106.573357, 'Liberation Monument', 'abc123');
    expect(url).toBe('https://uri.amap.com/marker?position=106.573357,29.56011&name=Liberation%20Monument');
    expect(url).not.toContain('query_place_id');
    expect(url).not.toContain('abc123');
  });

  // Review §10 case 4 / §5 row 15 — naver never emits query_place_id or the ID.
  it('naver + ID supplied: full naver URL, no query_place_id and no ID leakage', () => {
    const url = buildDeepLink('naver', 37.5665, 126.9780, 'Gyeongbokgung', 'abc123');
    expect(url).toBe('https://map.naver.com/p/search/Gyeongbokgung?c=126.978,37.5665,15,0,0,0,dh');
    expect(url).not.toContain('query_place_id');
    expect(url).not.toContain('abc123');
  });

  // Review §10 case 5 — URL-unsafe characters in the place ID are percent-encoded.
  it('google ID containing URL-unsafe characters is percent-encoded', () => {
    const url = buildDeepLink('google', 1, 2, 'label', 'abc 123&x=y');
    expect(url).toContain('query_place_id=abc%20123%26x%3Dy');
    expect(url).not.toContain('abc 123&x=y');
  });

  // Review §10 case 6 — coordinate precision is neither truncated nor rounded.
  it('coordinate precision is preserved verbatim, not truncated or rounded', () => {
    const url = buildDeepLink('google', 22.1, 120.30142339999999, 'label', null);
    expect(url).toContain('120.30142339999999');
  });

  // Case 7 — inherited from deleted backend twin (backend/tests/map.test.js:95-119):
  // amap URL shape with a plain label.
  it('amap URL shape with a plain label (ported from the deleted backend twin)', () => {
    const url = buildDeepLink('amap', 30.5728, 104.0668, 'Chengdu Panda Base', null);
    expect(url).toBe('https://uri.amap.com/marker?position=104.0668,30.5728&name=Chengdu%20Panda%20Base');
  });

  // Case 8 — inherited from deleted backend twin: naver URL shape with a plain label.
  it('naver URL shape with a plain label (ported from the deleted backend twin)', () => {
    const url = buildDeepLink('naver', 37.2, 127.1, 'Some Place', null);
    expect(url).toBe('https://map.naver.com/p/search/Some%20Place?c=127.1,37.2,15,0,0,0,dh');
  });

  // Case 9 — inherited from deleted backend twin: google URL shape with no ID.
  it('google URL shape with no ID (ported from the deleted backend twin)', () => {
    const url = buildDeepLink('google', 25.033, 121.565, 'Taipei 101', undefined);
    expect(url).toBe('https://www.google.com/maps/search/?api=1&query=25.033,121.565');
  });

  // Case 10 — inherited from deleted backend twin: an unrecognised provider
  // falls through to the Google URL form via buildDeepLink's own `default:`-
  // shaped fallback (the `if (provider === 'amap') ... if (provider === 'naver') ...`
  // chain falls to the google base). W1 keeps an unknown provider from ever
  // reaching this function in production, but the builder's own fallback
  // behavior is still a documented contract worth pinning.
  it('an unrecognised provider string falls through to the Google URL form', () => {
    const url = buildDeepLink('bing', 10, 20, 'label', null);
    expect(url).toBe('https://www.google.com/maps/search/?api=1&query=10,20');
  });

  // Case 11 — inherited from deleted backend twin: a label with special
  // characters is encoded (space -> %20) for amap.
  it('a label with special characters is encoded for amap (space -> %20)', () => {
    const url = buildDeepLink('amap', 1, 2, 'West Lake & Gardens', null);
    expect(url).toContain('name=West%20Lake%20%26%20Gardens');
  });

  // Case 12 — google + empty-string ID must omit the parameter entirely,
  // never emit a dangling `&query_place_id=`.
  it('google + empty-string ID omits query_place_id entirely', () => {
    const url = buildDeepLink('google', 1, 2, 'label', '');
    expect(url).toBe('https://www.google.com/maps/search/?api=1&query=1,2');
    expect(url).not.toContain('query_place_id');
  });
});
