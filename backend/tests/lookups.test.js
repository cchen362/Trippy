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

const { lookupFlightDetails, lookupHotelDetails, normalizeFlightQuery } = await import('../src/services/lookups.js');

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
    });
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
          departure: {
            airport: { iata: 'LHR', name: 'London Heathrow' },
            scheduledTime: { local: '2026-01-03 10:55+00:00' },
          },
          arrival: {
            airport: { iata: 'SIN', name: 'Singapore Changi' },
            scheduledTime: { local: '2026-01-04 07:50+08:00' },
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
