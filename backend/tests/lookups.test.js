import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfig = {
  flightDataProvider: '',
  aerodataboxApiKey: '',
  aerodataboxApiHost: 'aerodatabox.p.rapidapi.com',
  googlePlacesKey: 'places-key',
};

vi.mock('../src/config.js', () => ({
  config: mockConfig,
}));

const {
  lookupFlightDetails,
  lookupHotelDetails,
  normalizeFlightQuery,
  mergeDestinationPredictions,
  lookupDestinationPredictions,
} = await import('../src/services/lookups.js');

beforeEach(() => {
  mockConfig.flightDataProvider = '';
  mockConfig.aerodataboxApiKey = '';
  mockConfig.aerodataboxApiHost = 'aerodatabox.p.rapidapi.com';
  mockConfig.googlePlacesKey = 'places-key';
  vi.restoreAllMocks();
});

describe('lookupHotelDetails', () => {
  it('returns display name and formatted address for a selected place', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'place-123',
        displayName: { text: 'Waldorf Astoria Chengdu' },
        formattedAddress: '1199 Tianfu Avenue North, Chengdu, Sichuan, China',
      }),
    });

    const place = await lookupHotelDetails('place-123');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://places.googleapis.com/v1/places/place-123',
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': 'places-key',
          'X-Goog-FieldMask': 'id,displayName,formattedAddress,addressComponents,location',
        },
      },
    );
    expect(place).toEqual({
      placeId: 'place-123',
      name: 'Waldorf Astoria Chengdu',
      address: '1199 Tianfu Avenue North, Chengdu, Sichuan, China',
      city: null,
      tz: null,
      lat: null,
      lng: null,
      countryCode: null,
      locality: null,
      sublocality: null,
      adminAreas: { aal1: null, aal2: null },
    });
  });

  it('extracts geo identity fields for a Taiwan hotel with no locality component present alongside sublocality_level_1', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'place-tw-1',
        displayName: { text: 'Hotel Indigo Kaohsiung' },
        formattedAddress: '77 Wufu 3rd Road, Sinsing District, Kaohsiung City, Taiwan 800',
        addressComponents: [
          { types: ['country', 'political'], longText: 'Taiwan', shortText: 'TW' },
          { types: ['administrative_area_level_1', 'political'], longText: 'Kaohsiung City', shortText: 'Kaohsiung City' },
          { types: ['sublocality_level_1', 'sublocality', 'political'], longText: 'Sinsing District', shortText: 'Sinsing District' },
        ],
      }),
    });

    const place = await lookupHotelDetails('place-tw-1');

    expect(place.city).toBe('Kaohsiung City');
    expect(place.countryCode).toBe('TW');
    expect(place.locality).toBeNull();
    expect(place.sublocality).toBe('Sinsing District');
    expect(place.adminAreas).toEqual({ aal1: 'Kaohsiung City', aal2: null });
  });

  it('extracts geo identity fields for an Indonesian hotel with no locality component', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'place-id-1',
        displayName: { text: 'W Bali - Seminyak' },
        formattedAddress: 'Jl. Petitenget, Seminyak, Kabupaten Badung, Bali, Indonesia',
        addressComponents: [
          { types: ['country', 'political'], longText: 'Indonesia', shortText: 'ID' },
          { types: ['administrative_area_level_1', 'political'], longText: 'Bali', shortText: 'Bali' },
          { types: ['administrative_area_level_2', 'political'], longText: 'Kabupaten Badung', shortText: 'Kabupaten Badung' },
          { types: ['sublocality', 'political'], longText: 'Seminyak', shortText: 'Seminyak' },
        ],
      }),
    });

    const place = await lookupHotelDetails('place-id-1');

    expect(place.city).toBe('Kabupaten Badung');
    expect(place.countryCode).toBe('ID');
    expect(place.locality).toBeNull();
    expect(place.sublocality).toBe('Seminyak');
    expect(place.adminAreas).toEqual({ aal1: 'Bali', aal2: 'Kabupaten Badung' });
  });
});

describe('mergeDestinationPredictions', () => {
  it('ranks an exact-match region above a non-matching city for the same query', () => {
    const cityResults = [{ label: 'Kabupaten Badung', countryCode: 'ID', kind: 'city' }];
    const regionResults = [{ label: 'Bali', countryCode: 'ID', kind: 'region' }];

    const merged = mergeDestinationPredictions('Bali', cityResults, regionResults);

    const bali = merged.find((entry) => entry.label === 'Bali' && entry.kind === 'region');
    expect(bali).toBeDefined();
    if (merged.some((entry) => entry.label === 'Kabupaten Badung')) {
      expect(merged[0]).toEqual(bali);
    }
  });

  it('returns the city-kind entry for an exact city match with no region results', () => {
    const cityResults = [{ label: 'Chengdu', countryCode: 'CN', kind: 'city' }];

    const merged = mergeDestinationPredictions('Chengdu', cityResults, []);

    expect(merged).toEqual([{ label: 'Chengdu', countryCode: 'CN', kind: 'city' }]);
  });

  it('dedupes homonyms across city and region results, keeping the city-kind entry', () => {
    const cityResults = [{ label: 'Georgetown', countryCode: 'MY', kind: 'city' }];
    const regionResults = [{ label: 'Georgetown', countryCode: 'GY', kind: 'region' }];

    const merged = mergeDestinationPredictions('Georgetown', cityResults, regionResults);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({ label: 'Georgetown', countryCode: 'MY', kind: 'city' });
  });

  it('caps the merged result at 8 entries', () => {
    const cityResults = Array.from({ length: 10 }, (_, i) => ({
      label: `City ${i}`,
      countryCode: 'US',
      kind: 'city',
    }));

    const merged = mergeDestinationPredictions('City', cityResults, []);

    expect(merged).toHaveLength(8);
  });
});

describe('lookupDestinationPredictions', () => {
  it('makes two typed autocomplete calls without a session token and returns ranked, shaped results', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.includedPrimaryTypes.includes('locality')) {
        return {
          ok: true,
          json: async () => ({
            suggestions: [
              {
                placePrediction: {
                  structuredFormat: {
                    mainText: { text: 'Kabupaten Badung' },
                    secondaryText: { text: 'Indonesia' },
                  },
                },
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          suggestions: [
            {
              placePrediction: {
                structuredFormat: {
                  mainText: { text: 'Bali' },
                  secondaryText: { text: 'Indonesia' },
                },
              },
            },
          ],
        }),
      };
    });

    const suggestions = await lookupDestinationPredictions('Bali');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse(call[1].body);
      expect(body).not.toHaveProperty('sessionToken');
    }

    expect(suggestions).toEqual([
      { label: 'Bali', countryCode: 'ID', kind: 'region' },
      { label: 'Kabupaten Badung', countryCode: 'ID', kind: 'city' },
    ]);
  });
});

describe('normalizeFlightQuery', () => {
  it('normalizes combined flight numbers with spaces, dashes, and lowercase input', () => {
    expect(normalizeFlightQuery({ flightQuery: 'SQ317' })).toEqual({
      carrierCode: 'SQ',
      flightNumber: '317',
      flightDesignator: 'SQ317',
    });
    expect(normalizeFlightQuery({ flightQuery: 'SQ 317' }).flightDesignator).toBe('SQ317');
    expect(normalizeFlightQuery({ flightQuery: 'sq-317' }).flightDesignator).toBe('SQ317');
  });

  it('normalizes existing split carrier and flight number input', () => {
    expect(normalizeFlightQuery({ carrierCode: 'sq', flightNumber: ' 317 ' })).toEqual({
      carrierCode: 'SQ',
      flightNumber: '317',
      flightDesignator: 'SQ317',
    });
  });

  it('rejects ambiguous flight numbers without a carrier code', () => {
    expect(() => normalizeFlightQuery({ flightQuery: '317' })).toThrow(
      'Flight number must include an airline code',
    );
  });
});

describe('lookupFlightDetails', () => {
  it('returns manual-only normalized prefill when no provider is configured', async () => {
    const flight = await lookupFlightDetails({
      flightQuery: 'sq 317',
      departureDate: '2026-01-03',
    });

    expect(flight).toMatchObject({
      lookupStatus: 'manual_only',
      carrierCode: 'SQ',
      flightNumber: '317',
      departureDate: '2026-01-03',
      title: 'SQ 317',
    });
  });

  it('returns normalized AeroDataBox schedule data when provider is configured', async () => {
    mockConfig.flightDataProvider = 'aerodatabox';
    mockConfig.aerodataboxApiKey = 'rapid-key';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [
        {
          number: 'SQ317',
          airline: { name: 'Singapore Airlines', iata: 'SQ' },
          status: 'Delayed',
          departure: {
            airport: { iata: 'LHR', name: 'London Heathrow' },
            scheduledTime: { local: '2026-01-03 10:55+00:00' },
            terminal: '5',
            gate: 'B12',
            revisedTime: { local: '2026-01-03 11:30+00:00' },
          },
          arrival: {
            airport: { iata: 'SIN', name: 'Singapore Changi' },
            scheduledTime: { local: '2026-01-04 07:50+08:00' },
            terminal: '1',
            gate: 'D40',
            revisedTime: { local: '2026-01-04 08:25+08:00' },
          },
          aircraft: { model: 'Airbus A380' },
        },
      ],
    });

    const flight = await lookupFlightDetails({
      flightQuery: 'SQ 317',
      departureDate: '2026-01-03',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://aerodatabox.p.rapidapi.com/flights/number/SQ317/2026-01-03?dateLocalRole=Departure&withAircraftImage=false&withLocation=false&withFlightPlan=false',
      {
        headers: {
          Accept: 'application/json',
          'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com',
          'X-RapidAPI-Key': 'rapid-key',
        },
      },
    );
    expect(flight).toMatchObject({
      lookupStatus: 'found',
      provider: 'aerodatabox',
      title: 'SQ 317',
      carrierCode: 'SQ',
      flightNumber: '317',
      origin: 'LHR - London Heathrow',
      destination: 'SIN - Singapore Changi',
      startDatetime: '2026-01-03T10:55',
      endDatetime: '2026-01-04T07:50',
      airlineName: 'Singapore Airlines',
      aircraft: 'Airbus A380',
      status: 'Delayed',
      departureTerminal: '5',
      departureGate: 'B12',
      arrivalTerminal: '1',
      arrivalGate: 'D40',
      revisedDeparture: '2026-01-03T11:30',
      revisedArrival: '2026-01-04T08:25',
    });
  });

  it('resolves live status fields to null when AeroDataBox omits them', async () => {
    mockConfig.flightDataProvider = 'aerodatabox';
    mockConfig.aerodataboxApiKey = 'rapid-key';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => [
        {
          number: 'SQ317',
          airline: { name: 'Singapore Airlines', iata: 'SQ' },
          departure: {
            airport: { iata: 'LHR', name: 'London Heathrow' },
            scheduledTime: { local: '2026-01-03 10:55+00:00' },
          },
          arrival: {
            airport: { iata: 'SIN', name: 'Singapore Changi' },
            scheduledTime: { local: '2026-01-04 07:50+08:00' },
          },
        },
      ],
    });

    const flight = await lookupFlightDetails({
      flightQuery: 'SQ 317',
      departureDate: '2026-01-03',
    });

    expect(flight).toMatchObject({
      status: null,
      departureTerminal: null,
      departureGate: null,
      arrivalTerminal: null,
      arrivalGate: null,
      revisedDeparture: null,
      revisedArrival: null,
    });
  });

  it('returns manual fallback when AeroDataBox has no matching flight', async () => {
    mockConfig.flightDataProvider = 'aerodatabox';
    mockConfig.aerodataboxApiKey = 'rapid-key';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 204,
      text: async () => '',
    });

    const flight = await lookupFlightDetails({
      flightQuery: 'SQ317',
      departureDate: '2026-01-03',
    });

    expect(flight.lookupStatus).toBe('manual_only');
    expect(flight.note).toMatch(/No matching flight schedule/i);
  });

  it('returns manual fallback when AeroDataBox returns an upstream error', async () => {
    mockConfig.flightDataProvider = 'aerodatabox';
    mockConfig.aerodataboxApiKey = 'rapid-key';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'quota exceeded',
    });

    const flight = await lookupFlightDetails({
      flightQuery: 'SQ317',
      departureDate: '2026-01-03',
    });

    expect(flight.lookupStatus).toBe('manual_only');
    expect(flight.note).toMatch(/Flight schedule lookup is unavailable/i);
  });

  it('returns manual fallback when AeroDataBox cannot be reached', async () => {
    mockConfig.flightDataProvider = 'aerodatabox';
    mockConfig.aerodataboxApiKey = 'rapid-key';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const flight = await lookupFlightDetails({
      flightQuery: 'SQ317',
      departureDate: '2026-01-03',
    });

    expect(flight.lookupStatus).toBe('manual_only');
    expect(flight.note).toMatch(/Flight schedule lookup is unavailable/i);
  });
});
