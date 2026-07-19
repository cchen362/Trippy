// Plan 19 Wave 1: FX rate lookup for expense summary-currency conversion.
// Cache-first from fx_rates, then the fawazahmed0 currency-api (jsDelivr primary,
// pages.dev fallback host), bounded 5s timeout per host. Never throws — a total
// failure resolves to null so the fire-and-forget stamping caller can skip cleanly.
import { getDb } from '../db/database.js';

const FETCH_TIMEOUT_MS = 5000;
const NEGATIVE_CACHE_MS = 15 * 60 * 1000;

// In-flight dedupe: concurrent getRate calls for the same (base, quote, date) key
// share one network fetch rather than firing one each (e.g. N stragglers stamped
// in the same listExpenses bounded-wait pass).
const inFlight = new Map();

// Negative cache: a TOTAL miss (both hosts failed, or no rate for the pair) is
// remembered for NEGATIVE_CACHE_MS so repeated calls in that window short-circuit
// without hitting the network. Never written to fx_rates — only in-memory.
const negativeCache = new Map();

function memoKey(base, quote, date) {
  return `${base}:${quote}:${date}`;
}

// Test-only: clears both in-memory maps so tests stay isolated from each other.
export function _resetFxMemoryForTests() {
  inFlight.clear();
  negativeCache.clear();
}

function primaryUrl(base, date) {
  return `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/${base.toLowerCase()}.json`;
}

function fallbackUrl(base, date) {
  return `https://${date}.currency-api.pages.dev/v1/currencies/${base.toLowerCase()}.json`;
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function readCachedRate(base, quote, date) {
  const db = getDb();
  const row = db.prepare(`
    SELECT rate FROM fx_rates WHERE base_currency = ? AND quote_currency = ? AND rate_date = ?
  `).get(base, quote, date);
  return row ? row.rate : null;
}

function storeRate(base, quote, date, rate) {
  const db = getDb();
  db.prepare(`
    INSERT INTO fx_rates (base_currency, quote_currency, rate_date, rate)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(base_currency, quote_currency, rate_date) DO UPDATE SET rate = excluded.rate, fetched_at = datetime('now')
  `).run(base, quote, date, rate);
}

// getRate(base, quote, date) -> Promise<number|null>. base/quote are ISO 4217 codes
// (any case in, uppercase used for cache keys); date is 'YYYY-MM-DD' (historical =
// the expense's purchase date). Identity pairs resolve to 1 without hitting the network.
export async function getRate(base, quote, date) {
  if (!base || !quote || !date) return null;
  const baseCode = base.toUpperCase();
  const quoteCode = quote.toUpperCase();

  if (baseCode === quoteCode) return 1;

  const cached = readCachedRate(baseCode, quoteCode, date);
  if (cached !== null && cached !== undefined) return cached;

  const key = memoKey(baseCode, quoteCode, date);

  const negative = negativeCache.get(key);
  if (negative !== undefined && Date.now() - negative < NEGATIVE_CACHE_MS) {
    return null;
  }

  const existing = inFlight.get(key);
  if (existing) return existing;

  const attempt = fetchAndStoreRate(baseCode, quoteCode, date, key)
    .finally(() => inFlight.delete(key));
  inFlight.set(key, attempt);
  return attempt;
}

async function fetchAndStoreRate(baseCode, quoteCode, date, key) {
  let payload = await fetchWithTimeout(primaryUrl(baseCode, date), FETCH_TIMEOUT_MS);
  if (!payload) {
    payload = await fetchWithTimeout(fallbackUrl(baseCode, date), FETCH_TIMEOUT_MS);
  }
  if (!payload) {
    negativeCache.set(key, Date.now());
    return null;
  }

  const rateTable = payload[baseCode.toLowerCase()];
  const rate = rateTable ? rateTable[quoteCode.toLowerCase()] : undefined;
  if (typeof rate !== 'number' || !Number.isFinite(rate)) {
    negativeCache.set(key, Date.now());
    return null;
  }

  storeRate(baseCode, quoteCode, date, rate);
  negativeCache.delete(key);
  return rate;
}
