# Q1 — Booking Classification and Correction Review

**Status:** Investigation brief

**Parent:** [Product and Architecture Risk Review](2026-07-06-product-architecture-risk-review.md)

**Origin:** [Plan 4 Product Decision Q1](../plans/Implementation%20Plan%204%20UX%20Sweep%20Fixes.md#product-decisions-answered-by-owner-2026-07-05)

**Required companion:** [Trust, Reliability, and Operational Risk](2026-07-06-trust-reliability-and-operational-risk.md)

**Related:** [Q2 — Trip Geography and Map Architecture](2026-07-06-q2-trip-geography-and-map-architecture.md)

## Review question

How should Trippy let a user correct an incorrect booking classification without corrupting
type-specific metadata, linked itinerary stops, documents, Today behavior, or geography?

This report must treat two workflows separately:

1. **Unconfirmed extraction draft:** data has not yet become a persisted booking.
2. **Persisted booking conversion:** the booking, linked stop, documents and downstream behavior
   may already exist.

The first is a correction workflow. The second is a data conversion workflow. They should not
inherit the same risk classification merely because they currently share a modal.

## Why Q1 warrants further work

The booking type selector is disabled whenever `AddBookingModal` receives a `booking` prop.
`CaptureFlow` uses that same prop to edit an AI-extracted draft before confirmation. Therefore,
an AI classification error cannot be corrected during the review step.

This is a direct conflict with the product promise that users can dump messy booking material,
review what Trippy found, and correct it before saving.

### Provisional finding Q1-01 — extraction-review correction dead end

Likely user outcomes:

- accept a booking under the wrong type;
- exclude it and recreate it manually;
- abandon the import;
- fail to notice and discover inconsistent behavior later.

The agent should verify the full review path and document exactly which common fields survive
and which type-specific fields become inaccessible.

### Provisional finding Q1-02 — taxonomy inconsistencies

Review the meaning of every supported type across:

- add/edit form;
- extraction schema;
- Logistics grouping and card selection;
- linked-stop inference;
- Today anchor classification;
- flight-status behavior;
- map/location query construction;
- public sharing;
- co-pilot mutation context.

Known leads to verify:

- bus and ferry use transit-style form fields;
- bus and ferry may render as “Other” in Logistics;
- ferry and bus are not classified identically in linked-stop/Today behavior;
- a type-specific `detailsJson` can retain fields from a previous type.

## Authoritative-data problem

The current booking record mixes:

- common relational columns (`type`, title, datetimes, origin, destination);
- a flexible type-specific `detailsJson`;
- a linked itinerary stop derived from booking type and visibility;
- original import provenance and documents.

The review must recommend which data is canonical after a type conversion:

- Should common fields be preserved automatically?
- Should incompatible type-specific fields be deleted?
- Should original extraction data remain available as audit provenance?
- Should the linked stop be regenerated, converted in place, or removed?
- Should the operation be atomic?

## Options to investigate

### Option A — draft correction only

Allow type changes only before confirmation. Reset incompatible fields, retain safe common
fields, and send one canonical payload through the normal confirmation path.

This is the smallest response to Q1-01 and may be justified before persisted conversion.

### Option B — controlled persisted conversion

Expose a deliberate “Change booking type” flow that previews:

- fields that will be retained;
- fields that will be cleared;
- changes to the linked itinerary stop;
- changes to Today and status behavior.

The server applies the conversion atomically.

### Option C — recreate rather than convert

Create a replacement booking of the new type, transfer approved common data/documents, then
remove the old booking as one atomic operation.

This may create a cleaner audit boundary but has implications for identifiers, imported
provenance, collaborator references and linked stops.

## Dependencies

### Dependency on Q2

Changing a flight/train/bus/ferry can change inferred movement and day-city derivation. Q1
cannot define persisted conversion fully until Q2 defines how booking geography relates to
trip/day geography.

### Dependency on Trust

Type conversion and multi-booking confirmation must not partially apply. The Trust review
must define the atomicity and retry contract used here.

## Required scenarios

At minimum, investigate:

1. AI classifies a hotel as `other` before confirmation.
2. AI classifies a train as `bus` before confirmation.
3. A saved `other` booking becomes a hotel with an attached document.
4. A saved hotel becomes a generic reservation after its linked stop exists.
5. A flight becomes train after flight-provider metadata and status fields exist.
6. A type change moves or removes the booking-linked itinerary stop.
7. Conversion fails during location/photo enrichment.
8. Two collaborators edit the same booking classification.

## Expected report outcome

The completed review should recommend:

- an immediate decision for unconfirmed extraction drafts;
- whether persisted conversion is necessary now;
- one canonical type taxonomy;
- a field-retention/clearing matrix;
- linked-stop behavior;
- atomic server semantics;
- migration and test requirements.

It must feed confirmed findings and priority back into the
[parent review](2026-07-06-product-architecture-risk-review.md).
