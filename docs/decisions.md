# Product and engineering decisions

## September 27, 2026: preserve newer queued owner assignments

Owner-writeback retries must not apply obsolete assignments. Before the provider
callback, compare the job with the newest owner-writeback job for the same
organization and normalized contact email. Mark older work as superseded.

Hold a PostgreSQL transaction advisory lock for that contact through the callback
so an already-running older write finishes before a newer one can write. Release
the lock on success or failure. This concerns this installation's queued writes;
it does not claim protection from independent edits inside the CRM.

The existing database smoke now exercises retry ordering and concurrent callbacks
in a disposable PostgreSQL CI service. Local worker tests prove that superseded
jobs do not invoke the CRM adapter. Public release changes stay separate from the
unpublished local product backlog.

## 2026-08-23 — Separate the product from the marketing site

The application lives in `hot-potato`; the existing static website remains independently deployable. Product infrastructure will not depend on the marketing host.

## 2026-08-23 — One portable datastore

The first release uses PostgreSQL for product data and the job queue. This removes Redis from the self-hosting requirement while retaining safe concurrent job claims and transactional route/writeback creation.

## 2026-08-23 — Build a narrow real slice before connectors

Version 0.1 implements real rule evaluation, availability, assignment, persistence, audit history, and a worker adapter boundary. External CRM/calendar claims wait for verified OAuth-backed integrations.

## 2026-08-23 — Use references, not a wholesale fork

DayOtter and Cal.com informed the package boundaries and self-hosting posture. The initial source was written for Hot Potato and contains no copied third-party implementation.

## 2026-08-23 — AGPL code, reserved product identity

Source code uses AGPL-3.0-only. The Hot Potato name, mascot, and visual identity are not granted by the software license; see `TRADEMARKS.md`.

## 2026-08-24 — Encrypt refreshable OAuth connections

HubSpot and Google use authorization-code OAuth with refresh tokens. Access and refresh tokens are encrypted before storage with an environment-held AES-256-GCM key. A separate setup secret protects connector installation until full product authentication exists.

## 2026-08-24 — Fail closed on connected-calendar errors

Weekly schedules remain the local fallback when Google is not connected. Once it is connected, a failed or ambiguous free/busy lookup stops the route rather than assigning a representative whose availability was not verified.

## 2026-08-24 — Keep CRM writeback asynchronous

The routing decision commits before the external HubSpot call. The worker refreshes the token, resolves the selected representative by HubSpot owner email, and patches the contact by lead email. Retries remain visible in the existing durable job record.

## 2026-08-24 — Version the HubSpot app with the product

The HubSpot OAuth app uses the current 2026.03 developer platform and lives in `integrations/hubspot`. It is configured for marketplace distribution so the same source-controlled app can support additional customer accounts later. The HubSpot CLI key is intentionally limited to developer-project uploads; CRM access belongs only to the installed OAuth app.
