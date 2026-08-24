# Product and engineering decisions

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
