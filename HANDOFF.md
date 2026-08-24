# Morning Handoff

## Finished

- Created the separate public AGPL product repository and portable npm workspace.
- Built a real routing engine with nested rules, schedules, owner preservation, per-pool weighted round robin, and explicit failure states.
- Added transactional PostgreSQL decisions, idempotent request handling, assignment history, migrations, seed data, and a recoverable job queue.
- Added CRM/calendar adapter contracts, a development CRM worker, and Docker Compose startup.
- Built a responsive operator workspace that routes through the real API and displays rules, pools, results, and audit history.

## Try It

Run `docker compose up --build`, then open `http://localhost:3000`. The seeded lead matches Enterprise Northeast; select **Run route** to create a persisted assignment and CRM job.

## Checks

- `npm run format:check` — passed.
- `npm run typecheck` — passed across all workspaces.
- `npm test` — 7 routing tests passed.
- `npm run build` — all packages and the Next.js production build passed.
- PostgreSQL integration, idempotent API smoke, worker completion, Docker health, and browser QA at 1440px/390px all passed; mobile had no horizontal overflow or console errors.

## Decisions

- Use PostgreSQL for both application data and jobs so self-hosting requires one stateful service.
- Keep routing logic pure and provider-neutral; external side effects live behind adapters in the worker.
- License code as AGPL-3.0-only while reserving the Hot Potato name, mascot, and visual identity.

## Remaining

- Implement HubSpot OAuth, object lookup, and owner writeback.
- Implement Google Calendar OAuth and free/busy eligibility.
- Add authentication, organization onboarding, and secrets management.
- Add rule/pool editing rather than seeded configuration.
- Choose and deploy the first hosted application environment.

## Review First

- `apps/web/components/dashboard-client.tsx` for the product experience.
- `packages/router/src/router.ts` and its tests for assignment semantics.
- `packages/db/src/repository.ts` for transaction and job behavior.
