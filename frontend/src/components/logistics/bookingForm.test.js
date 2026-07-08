import { describe, expect, it } from 'vitest';
import { DEFAULT_FORM, normalizeForm, draftFormForType, resolveBookingMode, hydrateFormFromBooking } from './bookingForm.js';
import { toBookingConfirmPayload } from '../../services/bookingPayload.js';

describe('draftFormForType', () => {
  it('hotel to other: retains shared fields, clears hotel-only fields, drops hotel detailsJson keys', () => {
    const hotelForm = {
      ...DEFAULT_FORM,
      type: 'hotel',
      hotelName: 'The Peninsula Tokyo',
      hotelAddress: '1-8-1 Yurakucho, Chiyoda City',
      checkIn: '2026-08-10T15:00',
      checkOut: '2026-08-12T11:00',
      confirmationRef: 'CONF123',
      bookingSource: 'Booking.com',
      detailsJson: { city: 'Tokyo', placeId: 'place_abc', lat: 35.6, lng: 139.7 },
    };

    const result = draftFormForType(hotelForm, 'other');

    expect(result.type).toBe('other');
    expect(result.otherStart).toBe('2026-08-10T15:00');
    expect(result.otherEnd).toBe('2026-08-12T11:00');
    expect(result.location).toBe('1-8-1 Yurakucho, Chiyoda City');
    expect(result.confirmationRef).toBe('CONF123');
    expect(result.bookingSource).toBe('Booking.com');
    expect(result.hotelName).toBe('');
    expect(result.hotelCity).toBe('');

    const normalized = normalizeForm(result);
    expect(normalized.detailsJson).not.toHaveProperty('city');
    expect(normalized.detailsJson).not.toHaveProperty('placeId');
    expect(normalized.detailsJson).not.toHaveProperty('lat');
    expect(normalized.detailsJson).not.toHaveProperty('lng');
  });

  it('other to hotel: retains shared fields, clears other-only fields, drops note from detailsJson', () => {
    const otherForm = {
      ...DEFAULT_FORM,
      type: 'other',
      name: 'Museum entry',
      otherStart: '2026-08-10T09:00',
      otherEnd: '2026-08-10T12:00',
      location: 'Tokyo National Museum',
      notes: 'Bring student ID',
      confirmationRef: 'REF789',
      bookingSource: 'Direct',
      detailsJson: { note: 'Bring student ID' },
    };

    const result = draftFormForType(otherForm, 'hotel');

    expect(result.type).toBe('hotel');
    expect(result.checkIn).toBe('2026-08-10T09:00');
    expect(result.checkOut).toBe('2026-08-10T12:00');
    expect(result.hotelAddress).toBe('Tokyo National Museum');
    expect(result.confirmationRef).toBe('REF789');
    expect(result.bookingSource).toBe('Direct');
    expect(result.notes).toBe('');
    expect(result.name).toBe('');

    const normalized = normalizeForm(result);
    expect(normalized.detailsJson).not.toHaveProperty('note');
  });

  it('train to bus: retains route/times/tz, clears train-specific fields and their detailsJson keys', () => {
    const trainForm = {
      ...DEFAULT_FORM,
      type: 'train',
      trainNumber: 'G8694',
      fromCity: 'Chengdu',
      originStation: 'Chengdu East',
      toCity: 'Chongqing',
      destinationStation: 'Chongqing North',
      seatClass: 'Second / 二等座',
      trainDeparture: '2026-08-15T08:30',
      trainArrival: '2026-08-15T10:45',
      originTz: 'Asia/Shanghai',
      destinationTz: 'Asia/Shanghai',
      confirmationRef: 'TICKET456',
      bookingSource: 'Trip.com',
    };

    const result = draftFormForType(trainForm, 'bus');

    expect(result.type).toBe('bus');
    expect(result.fromCity).toBe('Chengdu');
    expect(result.toCity).toBe('Chongqing');
    expect(result.trainDeparture).toBe('2026-08-15T08:30');
    expect(result.trainArrival).toBe('2026-08-15T10:45');
    expect(result.originTz).toBe('Asia/Shanghai');
    expect(result.destinationTz).toBe('Asia/Shanghai');
    expect(result.confirmationRef).toBe('TICKET456');
    expect(result.bookingSource).toBe('Trip.com');

    expect(result.trainNumber).toBe('');
    expect(result.originStation).toBe('');
    expect(result.destinationStation).toBe('');
    expect(result.seatClass).toBe('');

    const normalized = normalizeForm(result);
    expect(normalized.detailsJson.trainNumber).toBeFalsy();
    expect(normalized.detailsJson.seatClass).toBeFalsy();
    expect(normalized.detailsJson.originStation).toBeFalsy();
  });

  it('confirm-payload cleanliness: hotel-to-other merge produces a clean payload with no stale hotel keys, provenance survives', () => {
    const hotelForm = {
      ...DEFAULT_FORM,
      type: 'hotel',
      hotelName: 'Grand Hyatt Singapore',
      hotelAddress: '10 Scotts Rd, Singapore',
      checkIn: '2026-09-01T15:00',
      checkOut: '2026-09-03T11:00',
      confirmationRef: 'HYATT001',
      bookingSource: 'Hyatt.com',
      detailsJson: { city: 'Singapore', placeId: 'place_xyz', lat: 1.3, lng: 103.8 },
    };

    // Simulates the original extracted draft data (pre-edit) — includes provenance
    // fields (confidence/assumptions) that toBookingConfirmPayload must retain.
    const originalDraftData = {
      type: 'hotel',
      title: 'Grand Hyatt Singapore',
      confirmationRef: 'HYATT001',
      bookingSource: 'Hyatt.com',
      startDatetime: '2026-09-01T15:00',
      endDatetime: '2026-09-03T11:00',
      origin: null,
      destination: '10 Scotts Rd, Singapore',
      terminalOrStation: null,
      originTz: null,
      destinationTz: null,
      detailsJson: { city: 'Singapore', placeId: 'place_xyz', lat: 1.3, lng: 103.8 },
      confidence: 0.82,
      assumptions: ['Assumed 3-night stay from confirmation email'],
    };

    const draftResult = draftFormForType(hotelForm, 'other');
    const merged = { ...originalDraftData, ...normalizeForm(draftResult) };
    const payload = toBookingConfirmPayload(merged);

    expect(payload.type).toBe('other');
    expect(payload.detailsJson).not.toHaveProperty('placeId');
    expect(payload.detailsJson).not.toHaveProperty('city');
    expect(payload.detailsJson).not.toHaveProperty('lat');
    expect(payload.detailsJson).not.toHaveProperty('lng');

    // Provenance fields are outside normalizeForm's output, so they survive the
    // spread merge from originalDraftData untouched.
    expect(payload.confidence).toBe(0.82);
    expect(payload.assumptions).toEqual(['Assumed 3-night stay from confirmation email']);
  });
});

describe('resolveBookingMode', () => {
  it('defaults to edit when a booking is provided and no mode is set', () => {
    expect(resolveBookingMode(undefined, { type: 'hotel' })).toBe('edit');
  });

  it('respects an explicit draft mode even when a booking is provided', () => {
    expect(resolveBookingMode('draft', { type: 'hotel' })).toBe('draft');
  });

  it('defaults to create when there is no booking and no mode is set', () => {
    expect(resolveBookingMode(undefined, null)).toBe('create');
  });
});

describe('hotel detailsJson geo fields round-trip', () => {
  const geoDetailsJson = {
    countryCode: 'ID',
    locality: null,
    sublocality: 'Seminyak',
    adminAreas: { aal1: 'Bali', aal2: 'Kabupaten Badung' },
    city: 'Kabupaten Badung',
    placeId: 'x',
  };

  it('normalizeForm retains the new geo fields on the hotel branch', () => {
    const hotelForm = {
      ...DEFAULT_FORM,
      type: 'hotel',
      hotelName: 'W Bali - Seminyak',
      hotelAddress: 'Jl. Petitenget, Seminyak',
      hotelCity: 'Kabupaten Badung',
      detailsJson: geoDetailsJson,
    };

    const normalized = normalizeForm(hotelForm);

    expect(normalized.detailsJson).toMatchObject(geoDetailsJson);
  });

  it('hydrateFormFromBooking restores the geo fields and hydrates hotelCity from detailsJson.city', () => {
    const normalized = normalizeForm({
      ...DEFAULT_FORM,
      type: 'hotel',
      hotelName: 'W Bali - Seminyak',
      hotelAddress: 'Jl. Petitenget, Seminyak',
      hotelCity: 'Kabupaten Badung',
      detailsJson: geoDetailsJson,
    });

    const booking = {
      type: 'hotel',
      title: normalized.title,
      destination: normalized.destination,
      startDatetime: normalized.startDatetime,
      endDatetime: normalized.endDatetime,
      detailsJson: normalized.detailsJson,
    };

    const hydrated = hydrateFormFromBooking(booking);

    expect(hydrated.detailsJson).toMatchObject(geoDetailsJson);
    expect(hydrated.hotelCity).toBe('Kabupaten Badung');
  });
});
