// The model-side shape of the Plan 34 D-34-1 extraction contract, for mocked SDK responses.
//
// Tests build the extraction the APP sees (`{ isTravelRelated, summary, language, bookings }`,
// nullable details, `confidence: { overall, fields }`). Under D-34-1 the model answers one JSON
// text block in the schema's shape (a `result` union, all 16 `details` keys as strings, a
// `fieldConfidence` array). This helper is the inverse of the server mapping (`toAppExtraction`
// in claude.js), so a fixture written once exercises the real parse -> validate -> map path.
import { EXTRACTION_DETAIL_FIELDS } from '../../src/services/claude.js';

const DEFAULT_USAGE = { input_tokens: 100, output_tokens: 50 };

function modelBooking(booking) {
  const details = {};
  for (const key of EXTRACTION_DETAIL_FIELDS) details[key] = '';
  for (const [key, value] of Object.entries(booking.details || {})) {
    if (!EXTRACTION_DETAIL_FIELDS.includes(key)) {
      throw new Error(`extractionReply: details key "${key}" is not in the extraction schema`);
    }
    details[key] = value === null || value === undefined ? '' : value;
  }
  const nullable = (value) => (value === undefined ? null : value);
  return {
    type: booking.type,
    title: booking.title,
    confirmationRef: nullable(booking.confirmationRef),
    bookingSource: nullable(booking.bookingSource),
    startDatetime: nullable(booking.startDatetime),
    endDatetime: nullable(booking.endDatetime),
    origin: nullable(booking.origin),
    destination: nullable(booking.destination),
    terminalOrStation: nullable(booking.terminalOrStation),
    originTz: nullable(booking.originTz),
    destinationTz: nullable(booking.destinationTz),
    details,
    confidence: { overall: booking.confidence?.overall },
    fieldConfidence: Object.entries(booking.confidence?.fields || {}).map(([field, level]) => ({ field, level })),
    assumptions: booking.assumptions || [],
    // D-38-1: 1-based file numbers on the wire; a fixture that names no positions came from file 1.
    sourceFiles: booking.filePositions ? booking.filePositions.map((p) => p + 1) : [1],
  };
}

export function modelExtraction(extraction) {
  const bookings = extraction.bookings || [];
  if (!extraction.isTravelRelated && bookings.length > 0) {
    throw new Error('extractionReply: a not_travel result cannot carry bookings (invalid fixture)');
  }
  const result = !extraction.isTravelRelated
    ? { kind: 'not_travel' }
    : bookings.length
      ? { kind: 'bookings', bookings: bookings.map(modelBooking) }
      : { kind: 'travel_no_booking' };
  return {
    summary: extraction.summary ?? 'Test extraction',
    language: extraction.language ?? 'en',
    result,
  };
}

export function textReply(text, { stop_reason = 'end_turn', usage = DEFAULT_USAGE } = {}) {
  return { content: [{ type: 'text', text }], stop_reason, usage };
}

export function extractionReply(extraction, { usage = DEFAULT_USAGE } = {}) {
  return textReply(JSON.stringify(modelExtraction(extraction)), { usage });
}
