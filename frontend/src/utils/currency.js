// Mirrors backend/src/utils/currency.js — keep in lockstep with the frozen contract
// (Plan 19 §"Currency utils"). Do not diverge on coverage or minor-unit rules.

const COUNTRY_CURRENCY = {
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

// Zero-decimal currencies only; everything else defaults to 2. Per the frozen
// contract, IDR is officially 2 decimals despite the low face value.
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND']);

export function currencyForCountry(isoAlpha2) {
  if (!isoAlpha2) return null;
  return COUNTRY_CURRENCY[isoAlpha2.toUpperCase()] ?? null;
}

export function minorUnitsFor(currency) {
  if (!currency) return 2;
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

// Formats an integer minor-unit amount as a locale-agnostic display string,
// e.g. formatMinor(8000, 'SGD') -> 'S$80.00', formatMinor(124000, 'JPY') -> '¥124,000'.
const CURRENCY_SYMBOLS = {
  USD: '$', SGD: 'S$', GBP: '£', EUR: '€', JPY: '¥', KRW: '₩', CNY: '¥',
  TWD: 'NT$', HKD: 'HK$', MOP: 'MOP$', AUD: 'A$', NZD: 'NZ$', CAD: 'C$',
  CHF: 'CHF', AED: 'AED', TRY: '₺', INR: '₹', THB: '฿', MYR: 'RM',
  IDR: 'Rp', PHP: '₱', VND: '₫',
};

export function formatMinor(amount, currency) {
  if (amount === null || amount === undefined || !currency) return '—';
  const decimals = minorUnitsFor(currency);
  const major = amount / 10 ** decimals;
  const formatted = major.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()] ?? `${currency.toUpperCase()} `;
  return `${symbol}${formatted}`;
}

// Common-currency picker list — every code the country map can produce, in a
// stable, sensible order (most-travelled first, then alphabetical).
export const COMMON_CURRENCIES = [
  'SGD', 'USD', 'JPY', 'CNY', 'KRW', 'TWD', 'HKD', 'THB', 'VND', 'MYR', 'IDR', 'PHP',
  'EUR', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF', 'AED', 'TRY', 'INR', 'MOP',
];
