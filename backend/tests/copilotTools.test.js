import { describe, it, expect } from 'vitest';
import {
  PROPOSE_ITINERARY_CHANGES_TOOL,
  SEARCH_DISCOVERY_CATALOGUE_TOOL,
  copilotTripContext,
} from '../src/services/copilotTools.js';

describe('PROPOSE_ITINERARY_CHANGES_TOOL', () => {
  it('is named propose_itinerary_changes with an operations array input schema', () => {
    expect(PROPOSE_ITINERARY_CHANGES_TOOL.name).toBe('propose_itinerary_changes');
    expect(typeof PROPOSE_ITINERARY_CHANGES_TOOL.input_schema).toBe('object');
    expect(PROPOSE_ITINERARY_CHANGES_TOOL.input_schema.properties.operations.type).toBe('array');
  });

  it('restricts operation action to the four known kinds', () => {
    const actionSchema = PROPOSE_ITINERARY_CHANGES_TOOL.input_schema.properties.operations.items.properties.action;
    expect(actionSchema.enum).toEqual(['add_stop', 'remove_stop', 'move_stop', 'update_stop']);
  });
});

describe('SEARCH_DISCOVERY_CATALOGUE_TOOL', () => {
  it('is named search_discovery_catalogue with destination required', () => {
    expect(SEARCH_DISCOVERY_CATALOGUE_TOOL.name).toBe('search_discovery_catalogue');
    expect(SEARCH_DISCOVERY_CATALOGUE_TOOL.input_schema.required).toEqual(['destination']);
  });

  it('restricts category to the exact known catalogue categories', () => {
    expect(SEARCH_DISCOVERY_CATALOGUE_TOOL.input_schema.properties.category.enum).toEqual([
      'essentials', 'food', 'nature', 'culture', 'nightlife', 'architecture', 'wellness', 'hidden_gems',
    ]);
  });
});

describe('copilotTripContext', () => {
  const tripDetail = {
    trip: {
      title: 'Sichuan Loop', startDate: '2026-05-01', endDate: '2026-05-10',
      travellers: 'couple', pace: 'moderate', interestTags: [], destinations: [], destinationCountries: [],
    },
    days: [{
      id: 'd1', date: '2026-05-01', city: 'Seed', resolvedCity: 'Chengdu',
      stops: [
        {
          id: 's1', title: 'Panda Base', type: 'experience', time: null, note: 'bring water', bookingId: null,
          lat: 30.7, lng: 104, unsplashPhotoUrl: 'http://x', resolvedName: 'X',
        },
        { id: 's2', title: 'Flight', type: 'transit', bookingId: 'b1' },
      ],
    }],
    bookings: [{
      id: 'b1', type: 'flight', title: 'CA123', confirmationRef: 'ABC123',
      startDatetime: '2026-05-01T08:00', endDatetime: '2026-05-01T10:00',
      origin: 'PEK', destination: 'CTU', documents: [{}], detailsJson: { foo: 1 }, bookingSource: 'manual',
    }],
  };

  it('marks stops with a bookingId as bookingLinked and others as not', () => {
    const ctx = copilotTripContext(tripDetail);
    const stops = ctx.days[0].stops;
    expect(stops.find((s) => s.id === 's1').bookingLinked).toBe(false);
    expect(stops.find((s) => s.id === 's2').bookingLinked).toBe(true);
  });

  it('keeps confirmationRef on bookings and drops documents/detailsJson', () => {
    const ctx = copilotTripContext(tripDetail);
    const booking = ctx.bookings[0];
    expect(booking.confirmationRef).toBe('ABC123');
    expect(booking).not.toHaveProperty('documents');
    expect(booking).not.toHaveProperty('detailsJson');
  });

  it('drops photo/coordinate noise from stops', () => {
    const ctx = copilotTripContext(tripDetail);
    const stop = ctx.days[0].stops.find((s) => s.id === 's1');
    expect(stop).not.toHaveProperty('unsplashPhotoUrl');
    expect(stop).not.toHaveProperty('lat');
    expect(stop).not.toHaveProperty('resolvedName');
  });

  it('uses resolvedCity for day.city when present, falling back to city', () => {
    const ctx = copilotTripContext(tripDetail);
    expect(ctx.days[0].city).toBe('Chengdu');

    const fallbackDetail = {
      ...tripDetail,
      days: [{ ...tripDetail.days[0], resolvedCity: undefined, city: 'Seed' }],
    };
    const fallbackCtx = copilotTripContext(fallbackDetail);
    expect(fallbackCtx.days[0].city).toBe('Seed');
  });
});
