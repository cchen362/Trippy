// IATA airport code → city name for major hubs.
// Used to derive a day's city from a flight booking without heuristic string parsing.
// Extend freely — entries here take priority over the formatted airport string.
const IATA_CITY = {
  // China
  PEK: 'Beijing', PKX: 'Beijing',
  PVG: 'Shanghai', SHA: 'Shanghai',
  CTU: 'Chengdu',
  CKG: 'Chongqing',
  CAN: 'Guangzhou',
  SZX: 'Shenzhen',
  HGH: 'Hangzhou',
  XIY: "Xi'an",
  KMG: 'Kunming',
  WUH: 'Wuhan',
  CSX: 'Changsha',
  NKG: 'Nanjing',
  TFU: 'Chengdu',
  // Southeast Asia
  SIN: 'Singapore',
  BKK: 'Bangkok', DMK: 'Bangkok',
  KUL: 'Kuala Lumpur',
  CGK: 'Jakarta',
  HAN: 'Hanoi', HND: 'Tokyo',
  SGN: 'Ho Chi Minh City',
  MNL: 'Manila',
  REP: 'Siem Reap',
  RGN: 'Yangon',
  VTE: 'Vientiane',
  // Japan
  NRT: 'Tokyo', TYO: 'Tokyo',
  KIX: 'Osaka', ITM: 'Osaka',
  CTS: 'Sapporo',
  FUK: 'Fukuoka',
  OKA: 'Okinawa',
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
  // Oceania
  SYD: 'Sydney',
  MEL: 'Melbourne',
  BNE: 'Brisbane',
  AKL: 'Auckland',
};

/**
 * Returns the city name for an IATA airport code, or null if not in the map.
 * @param {string|null|undefined} iataCode
 * @returns {string|null}
 */
export function cityFromIata(iataCode) {
  if (!iataCode) return null;
  return IATA_CITY[iataCode.trim().toUpperCase()] ?? null;
}

/**
 * Attempts to extract a city from a formatted airport string like "CTU - Chengdu Shuangliu".
 * Tries IATA lookup first, then falls back to taking the text after the last " - ".
 * @param {string|null|undefined} airportString
 * @returns {string|null}
 */
export function cityFromAirportString(airportString) {
  if (!airportString) return null;
  const iataMatch = airportString.trim().match(/^([A-Z]{3})\s*[-–]/);
  if (iataMatch) {
    const fromMap = cityFromIata(iataMatch[1]);
    if (fromMap) return fromMap;
  }
  // Fall back: take the segment after the last dash separator
  const dashIdx = airportString.lastIndexOf(' - ');
  if (dashIdx !== -1) {
    return airportString.slice(dashIdx + 3).trim() || null;
  }
  return null;
}
