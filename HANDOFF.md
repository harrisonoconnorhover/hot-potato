# Morning Handoff

## Finished

- Provisioned dedicated Google and HubSpot OAuth clients; credentials remain only in the ignored local `.env`.
- Connected Google Calendar successfully with identity/email and free/busy scopes; refreshable tokens are encrypted in PostgreSQL.
- Added, validated, uploaded, built, and deployed a source-controlled HubSpot 2026.03 marketplace app with the three required scopes.
- Scoped the HubSpot CLI key to developer-project uploads only and documented the provider app definition.
- Rebuilt the local stack with both clients configured; the Connections workspace reports Google live and HubSpot ready.

## Try It

Run `docker compose up -d`, open `http://localhost:3000`, and review **Connections**. Google should show the authorized account; HubSpot can complete after its policy acknowledgement.

## Checks

- `hs project validate`: passed.
- HubSpot build #1 and automatic deploy #1: succeeded.
- `docker compose up -d --build`: all images built; PostgreSQL healthy; web and worker started.
- `GET /api/connections`: Google connected and both providers configured.
- Formatting, lint, typecheck, 8 router tests, and 10 OAuth/integration tests passed.

## Decisions

- Keep the HubSpot app definition in `integrations/hubspot` on platform 2026.03.
- Use marketplace OAuth for eventual multi-account installation.
- Grant the HubSpot CLI only `developer.projects.write`.

## Remaining

- Explicitly accept HubSpot's acceptable-use policy, then rerun **Connect HubSpot** to finish the token exchange.
- Replace seeded `.example` representative emails with real HubSpot owner and Google Calendar emails before live routing.
- Add product user authentication before exposing the application publicly.
- Add organization onboarding and rule/pool editing.
- Choose and deploy the first hosted application environment.

## Review First

- `integrations/hubspot/src/app/app-hsmeta.json`
- `packages/integrations/src/google.ts` and `packages/integrations/src/hubspot.ts`
- `apps/web/components/dashboard-client.tsx`
