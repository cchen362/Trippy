// Shapes a normalized extracted-booking object into the payload the
// POST /api/import/artifacts/:id/confirm endpoint expects.
export function toBookingConfirmPayload(data) {
  return {
    type: data.type,
    title: data.title,
    confirmationRef: data.confirmationRef,
    bookingSource: data.bookingSource,
    startDatetime: data.startDatetime,
    endDatetime: data.endDatetime,
    origin: data.origin,
    destination: data.destination,
    terminalOrStation: data.terminalOrStation,
    originTz: data.originTz,
    destinationTz: data.destinationTz,
    detailsJson: data.detailsJson,
    confidence: data.confidence,
    assumptions: data.assumptions,
  };
}
