// IATA airport code → city name for major hubs.
// Keep in sync with backend/src/utils/airports.js.
const IATA_CITY = {
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
  NRT: 'Tokyo', TYO: 'Tokyo', HND: 'Tokyo',
  KIX: 'Osaka', ITM: 'Osaka',
  CTS: 'Sapporo',
  FUK: 'Fukuoka',
  OKA: 'Okinawa',
  ICN: 'Seoul', GMP: 'Seoul',
  PUS: 'Busan',
  DEL: 'New Delhi',
  BOM: 'Mumbai',
  BLR: 'Bangalore',
  MAA: 'Chennai',
  CCU: 'Kolkata',
  HYD: 'Hyderabad',
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
  DXB: 'Dubai', DWC: 'Dubai',
  AUH: 'Abu Dhabi',
  DOH: 'Doha',
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
  SYD: 'Sydney',
  MEL: 'Melbourne',
  BNE: 'Brisbane',
  AKL: 'Auckland',
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
