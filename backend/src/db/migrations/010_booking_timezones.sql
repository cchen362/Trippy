ALTER TABLE bookings ADD COLUMN origin_tz TEXT;
ALTER TABLE bookings ADD COLUMN destination_tz TEXT;

-- Backfill existing flight bookings from the AeroDataBox providerPayload already stored in details_json.
UPDATE bookings
SET
  origin_tz      = json_extract(details_json, '$.providerPayload.departure.airport.timeZone'),
  destination_tz = json_extract(details_json, '$.providerPayload.arrival.airport.timeZone')
WHERE type = 'flight'
  AND json_extract(details_json, '$.providerPayload.departure.airport.timeZone') IS NOT NULL;
