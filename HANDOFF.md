# Morning Handoff

## Finished

- Added refreshable HubSpot and Google OAuth install/callback flows with state validation, encrypted token storage, and refresh coalescing.
- Added Google Calendar free/busy filtering before assignment; connected-calendar errors fail closed and each decision records its availability source.
- Added queued HubSpot writeback that resolves a representative by owner email and updates the contact owner by lead email.
- Added a polished Connections workspace, setup-key protection, responsive states, provider tests, environment setup, and operator documentation.
- Preserved idempotent routes so duplicate external IDs return the original decision before making a calendar call.

## Try It

Follow `README.md` to create `.env` and the two provider OAuth clients. Run `docker compose up --build`, open `http://localhost:3000`, then connect both accounts in **Connections**.

## Checks

- Formatting, lint, typecheck, and production build passed across all workspaces.
- 8 router tests and 10 integration/OAuth tests passed.
- PostgreSQL migration, seed, decision lookup, and integration smoke passed.
- Rebuilt Docker stack passed health, idempotent route, durable worker, and saved-result checks.
- Browser QA passed at 1440px and 390px with no overflow, warnings, or errors; the mobile route interaction passed.

## Decisions

- Encrypt provider tokens with AES-256-GCM and keep the encryption key outside PostgreSQL.
- Require Google free/busy once connected; never guess availability after a provider failure.
- Keep HubSpot writeback asynchronous and retryable so routing does not wait on CRM latency.

## Remaining

- Create the HubSpot and Google OAuth clients, add the six uncommitted environment values, and authorize both accounts.
- Replace seeded `.example` representative emails with real HubSpot owner and Google Calendar emails before live routing.
- Add product user authentication before exposing the application publicly.
- Add organization onboarding and rule/pool editing.
- Choose and deploy the first hosted application environment.

## Review First

- `packages/integrations/src/google.ts` and `packages/integrations/src/hubspot.ts` for provider behavior.
- `apps/web/app/api/connections` and `apps/web/app/api/route/route.ts` for OAuth and routing flow.
- `apps/web/components/dashboard-client.tsx` for the operator experience.
