// ISO alpha-2 country code -> ISO 4217 currency code, and per-currency minor-unit
// (decimal place) counts, for Plan 19 (trip expenses). Money is always stored as an
// integer in minor units (cents/yen/etc — never REAL). This file is additive; it does
// not touch countries.js, which has no currency mapping.

const COUNTRY_TO_CURRENCY = {
  JP: 'JPY',
  KR: 'KRW',
  CN: 'CNY',
  TW: 'TWD',
  VN: 'VND',
  SG: 'SGD',
  TH: 'THB',
  MY: 'MYR',
  ID: 'IDR',
  PH: 'PHP',
  HK: 'HKD',
  MO: 'MOP',
  US: 'USD',
  GB: 'GBP',
  FR: 'EUR',
  IT: 'EUR',
  ES: 'EUR',
  DE: 'EUR',
  PT: 'EUR',
  NL: 'EUR',
  BE: 'EUR',
  CH: 'CHF',
  AT: 'EUR',
  GR: 'EUR',
  AU: 'AUD',
  NZ: 'NZD',
  CA: 'CAD',
  AE: 'AED',
  TR: 'TRY',
  IN: 'INR',
};

// Currencies with zero decimal places. IDR is officially 2 decimals despite common
// informal rounding to whole rupiah — per the frozen contract, only JPY/KRW/VND get 0.
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'VND']);

export function currencyForCountry(isoAlpha2) {
  if (!isoAlpha2 || typeof isoAlpha2 !== 'string') return null;
  return COUNTRY_TO_CURRENCY[isoAlpha2.trim().toUpperCase()] || null;
}

export function minorUnitsFor(currency) {
  if (!currency || typeof currency !== 'string') return 2;
  return ZERO_DECIMAL_CURRENCIES.has(currency.trim().toUpperCase()) ? 0 : 2;
}
