# Release readiness

Hot Potato is a development release of one routing and scheduling product. It includes direct and pooled meeting links, qualified Smart Router Links, operator handoff, recipient rescheduling/cancellation, a durable worker queue, and calendar/CRM/email adapters. The implementation and automated tests are reviewable; a passing local suite is not production or marketplace certification.

## Safe local verification

Use a disposable PostgreSQL database and fictional people, addresses, companies, and meetings. Leave provider and SMTP credentials unset when running unit tests or database integration checks. Never point the destructive integration smoke suite at an existing workspace: it seeds and mutates fixture data.

From a fresh checkout, install the locked dependencies with `npm ci`, then run:

```bash
npm run format:check
npm run typecheck
npm test
npm run build
```

For PostgreSQL checks, configure `DATABASE_URL` for the disposable database, a fictional `HOT_POTATO_ADMIN_USER`, and a local-only `HOT_POTATO_ADMIN_PASSWORD` of at least 12 characters. Then run:

```bash
npm run db:migrate
npm run db:bootstrap
npm run db:seed
npm run test:integration
HOT_POTATO_DISPOSABLE_DB=1 npm run test:booking-integration
```

The focused booking integration harness requires the explicit `HOT_POTATO_DISPOSABLE_DB=1` opt-in, a loopback PostgreSQL host, and a database name ending in `_ci` or `_test`. It rejects other targets before connecting. Build the packages and apply migrations first as shown above. Its fictional fixtures exercise concurrent/repeated cancellation, interrupted responses, uncertain rescheduling, worker completion, and transaction rollback without contacting providers.

The reference CI runs these checks against its own PostgreSQL service. The committed workflow contains verification only; deploying an instance is a separate operator action.

## What each check establishes

- Unit and route tests exercise deterministic rules, authorization, response shapes, stale/repeated submissions, lifecycle transitions, and provider adapter behavior with mocks.
- PostgreSQL integration checks exercise actual migrations, row/advisory locks, reservations, capacity, and queue coordination with synthetic records. Mocked provider callbacks do not prove a remote calendar or CRM write.
- A production build verifies compilation and bundling. A rendered local UI review verifies only the exercised pages, viewport, and fixtures.
- Development CRM and email adapters simulate completion. Email logs include recipient/subject metadata; fictional fixtures are required. Disabling SMTP does not disable native calendar invitations on connected Google or Microsoft accounts.

## Before a production release

Qualify each configured provider using explicitly authorized test accounts: OAuth grant/refresh/revocation, calendar availability and event identity, native invites/conferencing, CRM writeback, and SMTP delivery. Test timeouts and retries against a controlled provider environment without contacting real prospects.

Complete the [Gmail](../integrations/google-workspace/README.md#test-matrix) and [Outlook](../integrations/outlook/README.md#release-test-matrix) client matrices, including HTML/plain text, denied authorization, keyboard access, mobile behavior where supported, and interrupted requests. Deployment templates and declared scopes are not evidence of marketplace approval.

A production operator must also verify HTTPS and proxy boundaries, secret storage, restore-tested backups, retention rules, monitoring, dependency advisories, and migration/rollback procedures for their environment. No hosted deployment or production-data migration is certified by this repository's local checks.

Zoom uses a configured room URL; per-booking Zoom creation is not implemented. Salesforce integration is not implemented. Calendar provider availability is a point-in-time read, so conflicts created independently in the provider after a check may still require reconciliation.
