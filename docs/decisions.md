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
