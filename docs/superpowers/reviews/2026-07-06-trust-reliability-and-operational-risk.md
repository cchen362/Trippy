# Trust, Reliability, and Operational Risk Review

**Status:** Investigation brief

**Parent:** [Product and Architecture Risk Review](2026-07-06-product-architecture-risk-review.md)

**Feeds requirements into:** [Q1 Booking Classification](2026-07-06-q1-booking-classification-and-correction.md), [Q2 Trip Geography](2026-07-06-q2-trip-geography-and-map-architecture.md), [Q3 Discovery](2026-07-06-q3-discovery-personalization-and-shared-cache.md)

## Review question

What minimum privacy, consistency, recovery, resilience and verification guarantees must Trippy
meet before users can safely rely on it as the source of truth during a trip?

This report should distinguish:

- acceptable constraints for a small private deployment;
- blockers for broader consumer use;
- safeguards required by the Q1–Q3 implementation designs.

## Scope

### Privacy and authorization

- PWA caching of private trip details, imported artifacts and booking attachments
- logout, account switching and shared-device behavior
- collaborator removal and cached offline access
- public share-link revocation and cached public views
- document retention and deletion
- encryption and host access to the SQLite file

### Data consistency

- multi-booking import confirmation
- co-pilot multi-operation application
- booking creation plus linked-stop enrichment
- booking-type conversion proposed by Q1
- geography migration/reconciliation proposed by Q2
- collaborator concurrency and last-write-wins behavior

### Operational resilience

- SQLite/WAL backup correctness
- off-machine backup and restore drills
- migration failure and rollback preparation
- graceful shutdown and database checkpoint behavior
- external API timeouts, retries and degradation
- AI, Places, Unsplash, map and flight-provider quotas/costs

### Security baseline

- session lifecycle and revocation
- password policy and account recovery
- security headers and content policy
- upload signature validation
- dependency advisories
- rate-limit scope and behavior behind a proxy

### Verification and visibility

- end-to-end browser coverage
- CI requirements
- structured errors and latency
- API cost and quota visibility
- cache and database growth monitoring
- accessibility verification

## Provisional finding TR-01 — offline data can outlive access

The service worker intentionally caches sensitive booking artifacts and attachments for offline
travel use. That is valuable, but logout currently removes user identity state rather than
explicitly purging private response caches.

Investigate:

1. User A logs out and User B logs in on the same browser profile.
2. A collaborator is removed while their device is offline.
3. A ticket URL remains in browser history after access is revoked.
4. A public share link is revoked after a share response was cached.
5. Cache eviction or browser storage pressure removes only part of an offline trip.

The report must propose an explicit privacy contract: offline availability cannot be treated as
free if it makes server-side revocation ineffective.

## Provisional finding TR-02 — partial multi-step writes

Known leads:

- imported bookings are created sequentially before the artifact is marked confirmed;
- co-pilot synchronous operations and asynchronous add/update operations are not one atomic
  unit;
- booking insertion can precede linked-stop location/photo enrichment.

Investigate retries, duplicate creation, idempotency and the user-visible state after each
possible failure point.

This work directly defines the transaction semantics required by Q1 type conversion and Q2
geography reconciliation.

## Provisional finding TR-03 — recovery and external dependencies

The product's main data and documents live in SQLite. A local Docker volume is not a disaster
recovery strategy by itself.

The review should verify:

- whether a current backup job actually exists;
- whether backups include WAL-consistent data;
- whether a backup has been restored successfully;
- whether a copy survives loss of the application host;
- retention and growth implications of stored documents.

External provider calls should be mapped for:

- timeout/abort behavior;
- retry behavior;
- synchronous user-request coupling;
- graceful fallback;
- rate and cost controls;
- startup requirements for optional features.

## Cross-report requirements

### Requirements imposed on Q1

- Draft confirmation must be idempotent.
- Persisted conversion must be atomic.
- Documents and import provenance must not become orphaned.
- Retry must not duplicate bookings or stops.

### Requirements imposed on Q2

- Existing trip migration must be reversible or recoverable.
- Reconciliation must not silently move/delete stops.
- Map/provider changes must degrade safely offline.
- Mixed-country fixtures must be preserved as regression tests.

### Requirements imposed on Q3

- Global cache requests need cost/rate bounds.
- Bad shared data needs recovery/removal.
- Cache size and latency need observability.
- Personalization failure should fall back to the base catalogue.

## Severity framework

Agents should rate each finding on:

- **Impact:** inconvenience, wrong plan, privacy exposure, data loss, trip-day failure
- **Frequency:** edge case, likely on complex trips, routine
- **Detectability:** obvious immediately versus discovered later
- **Recoverability:** self-service, admin repair, irreversible
- **Operating envelope:** small trusted group versus public users

Do not use a green test suite as proof that operational behavior is safe. Explicitly identify
which risks have unit coverage, browser coverage, deployment evidence and restore evidence.

## Expected report outcome

The completed review should produce:

1. A minimum trust baseline before broader use.
2. Critical versus scale-dependent risks.
3. Atomicity and idempotency requirements.
4. Offline privacy and cache-revocation policy.
5. Backup/restore and migration requirements.
6. Timeout, retry, rate and cost-control standards.
7. Security-hardening priorities.
8. Required CI, end-to-end tests and observability.
9. Requirements that every Q1–Q3 implementation plan must inherit.

Confirmed findings and sequencing must be returned to the
[parent review](2026-07-06-product-architecture-risk-review.md).
