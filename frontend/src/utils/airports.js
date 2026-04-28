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

// IATA airport code → IANA timezone name.
// Covers the same airports as IATA_CITY. Used as a fallback when a booking
// pre-dates migration 010 and has no originTz / destinationTz column value.
const IATA_TZ = {
  // China (all Asia/Shanghai, UTC+8, no DST)
  PEK: 'Asia/Shanghai', PKX: 'Asia/Shanghai',
  PVG: 'Asia/Shanghai', SHA: 'Asia/Shanghai',
  CTU: 'Asia/Shanghai', TFU: 'Asia/Shanghai',
  CKG: 'Asia/Shanghai',
  CAN: 'Asia/Shanghai',
  SZX: 'Asia/Shanghai',
  HGH: 'Asia/Shanghai',
  XIY: 'Asia/Shanghai',
  KMG: 'Asia/Shanghai',
  WUH: 'Asia/Shanghai',
  CSX: 'Asia/Shanghai',
  NKG: 'Asia/Shanghai',
  // Southeast Asia
  SIN: 'Asia/Singapore',
  BKK: 'Asia/Bangkok',  DMK: 'Asia/Bangkok',
  KUL: 'Asia/Kuala_Lumpur', SZB: 'Asia/Kuala_Lumpur',
  CGK: 'Asia/Jakarta',
  HAN: 'Asia/Bangkok',
  SGN: 'Asia/Ho_Chi_Minh',
  MNL: 'Asia/Manila',
  REP: 'Asia/Phnom_Penh',
  RGN: 'Asia/Yangon',
  VTE: 'Asia/Vientiane',
  // Malaysia (additional)
  IPN: 'Asia/Kuala_Lumpur', PEN: 'Asia/Kuala_Lumpur', LGK: 'Asia/Kuala_Lumpur',
  JHB: 'Asia/Kuala_Lumpur', BKI: 'Asia/Kuala_Lumpur', KCH: 'Asia/Kuala_Lumpur',
  MKZ: 'Asia/Kuala_Lumpur',
  // Thailand (additional)
  HKT: 'Asia/Bangkok', CNX: 'Asia/Bangkok', USM: 'Asia/Bangkok', HDY: 'Asia/Bangkok',
  // Vietnam (additional)
  DAD: 'Asia/Ho_Chi_Minh', HUI: 'Asia/Ho_Chi_Minh',
  CXR: 'Asia/Ho_Chi_Minh', VCA: 'Asia/Ho_Chi_Minh',
  // Taiwan
  TPE: 'Asia/Taipei', TSA: 'Asia/Taipei',
  // Indonesia (additional)
  DPS: 'Asia/Makassar', SUB: 'Asia/Jakarta', UPG: 'Asia/Makassar',
  // Philippines
  CEB: 'Asia/Manila', DVO: 'Asia/Manila', ILO: 'Asia/Manila',
  PPS: 'Asia/Manila', KLO: 'Asia/Manila', MPH: 'Asia/Manila',
  // Cambodia
  PNH: 'Asia/Phnom_Penh',
  // Myanmar (additional)
  MDL: 'Asia/Yangon',
  // Laos (additional)
  LPQ: 'Asia/Vientiane',
  // Japan (all Asia/Tokyo)
  NRT: 'Asia/Tokyo', TYO: 'Asia/Tokyo', HND: 'Asia/Tokyo',
  KIX: 'Asia/Tokyo', ITM: 'Asia/Tokyo',
  CTS: 'Asia/Tokyo', FUK: 'Asia/Tokyo', OKA: 'Asia/Tokyo',
  NGO: 'Asia/Tokyo', KMJ: 'Asia/Tokyo', KOJ: 'Asia/Tokyo',
  // South Korea
  ICN: 'Asia/Seoul', GMP: 'Asia/Seoul', PUS: 'Asia/Seoul',
  // India (all Asia/Kolkata)
  DEL: 'Asia/Kolkata', BOM: 'Asia/Kolkata', BLR: 'Asia/Kolkata',
  MAA: 'Asia/Kolkata', CCU: 'Asia/Kolkata', HYD: 'Asia/Kolkata',
  COK: 'Asia/Kolkata', TRV: 'Asia/Kolkata', AMD: 'Asia/Kolkata',
  // Europe
  LHR: 'Europe/London', LGW: 'Europe/London', STN: 'Europe/London',
  LTN: 'Europe/London', LCY: 'Europe/London',
  CDG: 'Europe/Paris',  ORY: 'Europe/Paris',
  AMS: 'Europe/Amsterdam',
  FRA: 'Europe/Berlin', MUC: 'Europe/Berlin',
  ZRH: 'Europe/Zurich', GVA: 'Europe/Zurich',
  FCO: 'Europe/Rome',   CIA: 'Europe/Rome',
  MXP: 'Europe/Rome',   LIN: 'Europe/Rome',
  BCN: 'Europe/Madrid', MAD: 'Europe/Madrid',
  LIS: 'Europe/Lisbon',
  VIE: 'Europe/Vienna',
  BRU: 'Europe/Brussels',
  CPH: 'Europe/Copenhagen',
  OSL: 'Europe/Oslo',
  ARN: 'Europe/Stockholm',
  HEL: 'Europe/Helsinki',
  DUB: 'Europe/Dublin',
  PRG: 'Europe/Prague',
  BUD: 'Europe/Budapest',
  WAW: 'Europe/Warsaw',
  ATH: 'Europe/Athens',
  IST: 'Europe/Istanbul', SAW: 'Europe/Istanbul',
  // Middle East
  DXB: 'Asia/Dubai',  DWC: 'Asia/Dubai',
  AUH: 'Asia/Dubai',
  DOH: 'Asia/Qatar',
  AMM: 'Asia/Amman',
  BEY: 'Asia/Beirut',
  // Africa
  JNB: 'Africa/Johannesburg', CPT: 'Africa/Johannesburg',
  CAI: 'Africa/Cairo',
  NBO: 'Africa/Nairobi',
  CMN: 'Africa/Casablanca',
  ADD: 'Africa/Addis_Ababa',
  // Americas
  JFK: 'America/New_York', LGA: 'America/New_York', EWR: 'America/New_York',
  MIA: 'America/New_York', BOS: 'America/New_York',
  LAX: 'America/Los_Angeles', SFO: 'America/Los_Angeles', SEA: 'America/Los_Angeles',
  ORD: 'America/Chicago',  MDW: 'America/Chicago',
  YYZ: 'America/Toronto',
  YVR: 'America/Vancouver',
  MEX: 'America/Mexico_City',
  GRU: 'America/Sao_Paulo', GIG: 'America/Sao_Paulo',
  EZE: 'America/Argentina/Buenos_Aires',
  BOG: 'America/Bogota',
  LIM: 'America/Lima',
  SCL: 'America/Santiago',
  // Oceania
  SYD: 'Australia/Sydney',
  MEL: 'Australia/Melbourne',
  BNE: 'Australia/Brisbane',
  AKL: 'Pacific/Auckland',
};

export function tzFromIata(iataCode) {
  if (!iataCode) return null;
  return IATA_TZ[iataCode.trim().toUpperCase()] ?? null;
}

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
