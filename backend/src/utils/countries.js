// Country name → ISO 3166-1 alpha-2 code, for normalizing free-text country
// input (manual entry, Google Places secondary text like "Sichuan, China")
// into the codes destination_countries/mapConfig.js expect.

// Intl has no enumeration API for ISO 3166-1 region codes (Intl.supportedValuesOf
// only covers calendar/collation/currency/numberingSystem/timeZone/unit), so the
// code list itself is hardcoded — English names are still derived from Intl.DisplayNames
// rather than hand-maintained, since that data does change (renames, capitalization).
const REGION_CODES = [
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS', 'BT', 'BV', 'BW', 'BY', 'BZ',
  'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ',
  'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ',
  'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET',
  'FI', 'FJ', 'FK', 'FM', 'FO', 'FR',
  'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY',
  'HK', 'HM', 'HN', 'HR', 'HT', 'HU',
  'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT',
  'JE', 'JM', 'JO', 'JP',
  'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ',
  'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY',
  'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ',
  'NA', 'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ',
  'OM',
  'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY',
  'QA',
  'RE', 'RO', 'RS', 'RU', 'RW',
  'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS', 'ST', 'SV', 'SX', 'SY', 'SZ',
  'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW', 'TZ',
  'UA', 'UG', 'UM', 'US', 'UY', 'UZ',
  'VA', 'VC', 'VE', 'VG', 'VI', 'VN', 'VU',
  'WF', 'WS',
  'YE', 'YT',
  'ZA', 'ZM', 'ZW',
];
const REGION_CODE_SET = new Set(REGION_CODES);

const NAME_TO_CODE = new Map();
const displayNames = new Intl.DisplayNames(['en'], { type: 'region' });
for (const code of REGION_CODES) {
  const name = displayNames.of(code);
  if (name) NAME_TO_CODE.set(name.toLowerCase(), code);
}

// Colloquial/alternate names Intl.DisplayNames doesn't cover or names differently.
const ALIAS_TO_CODE = {
  usa: 'US',
  'united states of america': 'US',
  uk: 'GB',
  'united kingdom': 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  'northern ireland': 'GB',
  'south korea': 'KR',
  korea: 'KR',
  'hong kong': 'HK',
  macau: 'MO',
  macao: 'MO',
  taiwan: 'TW',
  'czech republic': 'CZ',
  vietnam: 'VN',
  russia: 'RU',
};

export function countryCodeFromName(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (trimmed.length === 2) {
    const upper = trimmed.toUpperCase();
    if (REGION_CODE_SET.has(upper)) return upper;
  }

  // Google Places secondaryText can be "Region, Country" — the country is the last segment.
  const segment = trimmed.split(',').pop().trim().toLowerCase();
  return ALIAS_TO_CODE[segment] || NAME_TO_CODE.get(segment) || null;
}
