// IATA airport code → city name for major hubs.
// Keep in sync with backend/src/utils/airports.js.
const IATA_CITY = {
  // China
  PEK: 'Beijing', PKX: 'Beijing',
  PVG: 'Shanghai', SHA: 'Shanghai',
  CTU: 'Chengdu', TFU: 'Chengdu',
  CKG: 'Chongqing',
  CAN: 'Guangzhou',
  SZX: 'Shenzhen',
  HGH: 'Hangzhou',
  XIY: "Xi'an",
  KMG: 'Kunming',
  WUH: 'Wuhan',
  CSX: 'Changsha',
  NKG: 'Nanjing',
  // Southeast Asia
  SIN: 'Singapore',
  BKK: 'Bangkok', DMK: 'Bangkok',
  KUL: 'Kuala Lumpur',
  CGK: 'Jakarta',
  HAN: 'Hanoi',
  SGN: 'Ho Chi Minh City',
  MNL: 'Manila',
  REP: 'Siem Reap',
  RGN: 'Yangon',
  VTE: 'Vientiane',
  // Malaysia
  IPN: 'Ipoh', PEN: 'Penang', LGK: 'Langkawi',
  JHB: 'Johor Bahru', BKI: 'Kota Kinabalu', KCH: 'Kuching',
  MKZ: 'Melaka', SZB: 'Kuala Lumpur',
  // Thailand (additional)
  HKT: 'Phuket', CNX: 'Chiang Mai', USM: 'Koh Samui', HDY: 'Hat Yai',
  // Vietnam (additional)
  DAD: 'Da Nang', HUI: 'Hue', CXR: 'Nha Trang', VCA: 'Can Tho',
  // Taiwan
  TPE: 'Taipei', TSA: 'Taipei',
  // Indonesia (additional)
  DPS: 'Bali', SUB: 'Surabaya', UPG: 'Makassar',
  // Philippines
  CEB: 'Cebu', DVO: 'Davao', ILO: 'Iloilo',
  PPS: 'Puerto Princesa', KLO: 'Kalibo', MPH: 'Caticlan',
  // Cambodia
  PNH: 'Phnom Penh',
  // Myanmar (additional)
  MDL: 'Mandalay',
  // Laos (additional)
  LPQ: 'Luang Prabang',
  // Japan
  NRT: 'Tokyo', TYO: 'Tokyo', HND: 'Tokyo',
  KIX: 'Osaka', ITM: 'Osaka',
  CTS: 'Sapporo',
  FUK: 'Fukuoka',
  OKA: 'Okinawa',
  NGO: 'Nagoya', KMJ: 'Kumamoto', KOJ: 'Kagoshima',
  // South Korea
  ICN: 'Seoul', GMP: 'Seoul',
  PUS: 'Busan',
  // India
  DEL: 'New Delhi',
  BOM: 'Mumbai',
  BLR: 'Bangalore',
  MAA: 'Chennai',
  CCU: 'Kolkata',
  HYD: 'Hyderabad',
  COK: 'Kochi', TRV: 'Thiruvananthapuram', AMD: 'Ahmedabad',
  // Europe
  LHR: 'London', LGW: 'London', STN: 'London', LTN: 'London', LCY: 'London',
  CDG: 'Paris', ORY: 'Paris',
  AMS: 'Amsterdam',
  FRA: 'Frankfurt',
  MUC: 'Munich',
  ZRH: 'Zurich',
  GVA: 'Geneva',
  FCO: 'Rome', CIA: 'Rome',
  MXP: 'Milan', LIN: 'Milan',
  BCN: 'Barcelona',
  MAD: 'Madrid',
  LIS: 'Lisbon',
  VIE: 'Vienna',
  BRU: 'Brussels',
  CPH: 'Copenhagen',
  OSL: 'Oslo',
  ARN: 'Stockholm',
  HEL: 'Helsinki',
  DUB: 'Dublin',
  PRG: 'Prague',
  BUD: 'Budapest',
  WAW: 'Warsaw',
  ATH: 'Athens',
  IST: 'Istanbul', SAW: 'Istanbul',
  // Middle East
  DXB: 'Dubai', DWC: 'Dubai',
  AUH: 'Abu Dhabi',
  DOH: 'Doha',
  AMM: 'Amman', BEY: 'Beirut',
  // Africa
  JNB: 'Johannesburg', CPT: 'Cape Town', CAI: 'Cairo',
  NBO: 'Nairobi', CMN: 'Casablanca', ADD: 'Addis Ababa',
  // Americas
  JFK: 'New York', LGA: 'New York', EWR: 'New York',
  LAX: 'Los Angeles',
  SFO: 'San Francisco',
  ORD: 'Chicago', MDW: 'Chicago',
  MIA: 'Miami',
  BOS: 'Boston',
  SEA: 'Seattle',
  YYZ: 'Toronto',
  YVR: 'Vancouver',
  MEX: 'Mexico City',
  GRU: 'São Paulo',
  GIG: 'Rio de Janeiro',
  EZE: 'Buenos Aires',
  BOG: 'Bogota', LIM: 'Lima', SCL: 'Santiago',
  // Oceania
  SYD: 'Sydney',
  MEL: 'Melbourne',
  BNE: 'Brisbane',
  AKL: 'Auckland',
};

// Case-insensitive city alias map. Keys are uppercase. Covers common abbreviations
// and alternate names users type in free-text fields that autocomplete may not catch.
const CITY_ALIASES = {
  KL:           'Kuala Lumpur',
  HK:           'Hong Kong',
  HCM:          'Ho Chi Minh City',
  HCMC:         'Ho Chi Minh City',
  SAIGON:       'Ho Chi Minh City',
  NYC:          'New York',
  LA:           'Los Angeles',
  SF:           'San Francisco',
  DC:           'Washington',
  SUVARNABHUMI: 'Bangkok',
  'DON MUEANG': 'Bangkok',
};

export function cityFromIata(iataCode) {
  if (!iataCode) return null;
  return IATA_CITY[iataCode.trim().toUpperCase()] ?? null;
}

/**
 * Extracts a city from a formatted airport string like "CTU - Chengdu Shuangliu".
 * Tries IATA map first, then the text after the last " - ".
 */
export function cityFromAirportString(airportString) {
  if (!airportString) return null;
  const iataMatch = airportString.trim().match(/^([A-Z]{3})\s*[-–]/);
  if (iataMatch) {
    const fromMap = cityFromIata(iataMatch[1]);
    if (fromMap) return fromMap;
  }
  const dashIdx = airportString.lastIndexOf(' - ');
  if (dashIdx !== -1) {
    return airportString.slice(dashIdx + 3).trim() || null;
  }
  return null;
}

/**
 * Resolves common city abbreviations and alternate names to their canonical form.
 * Passthrough for already-canonical names. Never returns null — callers guard empty strings separately.
 */
export function canonicalCity(str) {
  if (!str) return str;
  return CITY_ALIASES[str.trim().toUpperCase()] ?? str;
}
