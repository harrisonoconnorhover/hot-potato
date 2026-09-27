# Hot Potato

Open-source inbound lead routing for GTM teams.

Hot Potato turns a lead payload into an explainable assignment: match the first eligible rule, preserve a valid owner when possible, choose an available rep with weighted round robin, persist the decision, and queue CRM writeback.

## Run it

The complete local stack needs Docker and nothing else:

```bash
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). The compose stack starts PostgreSQL, applies migrations, loads a development workspace, runs the web/API process, and starts the job worker.

To work on the app with Node.js 22+:

```bash
npm install
docker compose up -d postgres
npm run db:setup
npm run build --workspace @hot-potato/integrations
npm run build --workspace @hot-potato/worker
npm run dev
```

Run `npm run dev:worker` in a second terminal. The setup builds the local packages before starting the web app and worker; a fresh checkout does not include their generated JavaScript. After changing a shared package or worker source, rerun that package's build command.

## What works today

- Priority-ordered rules over nested CRM-style fields
- Weekly schedules, active-rep filtering, and current-owner preservation
- Transaction-safe weighted round robin with per-pool assignment state
- PostgreSQL decision history and idempotent external request IDs
- Postgres-backed jobs with retries and concurrent-worker-safe claiming
- Google OAuth and Calendar free/busy filtering before assignment
- HubSpot OAuth and queued contact-owner writeback after assignment
- A responsive operator workspace backed by the real routing API

Without provider credentials, the development CRM adapter completes queued jobs locally and weekly schedules drive availability. Once connected, Google Calendar becomes a required free/busy check and HubSpot jobs write the selected owner to the contact matched by email.

## Inspect the retry failure case

An older failed owner update must not overwrite a newer assignment when it retries. The worker checks the latest queued assignment for the same organization and contact, skips obsolete work as `superseded`, and serializes owner writes for that contact. The operator view preserves that outcome instead of reporting a CRM write that never happened.

The [database smoke check](packages/db/src/integration-smoke.ts) exercises an old failure, a newer success, and the skipped retry, plus two concurrent writes. The [worker tests](apps/worker/test/owner-writeback.test.ts) verify that obsolete jobs never call the adapter. Run `npm test`, then `npm run db:setup && npm run test:integration` against a disposable PostgreSQL database. CI runs these checks with synthetic callbacks; no provider credentials are required.

This guard orders this installation's queued writes. It does not detect ownership changes made directly in the CRM.

## Connect HubSpot and Google Calendar

Copy `.env.example` to `.env` and generate the two local secrets shown in that file.

The current HubSpot developer-platform app definition is versioned in [`integrations/hubspot`](integrations/hubspot). Upload it with the HubSpot CLI, then place its client ID and secret in `.env`. It requests this redirect URL:

```text
http://localhost:3000/api/connections/hubspot/callback
```

Grant `oauth`, `crm.objects.contacts.write`, and `crm.objects.owners.read`. Hot Potato resolves a representative by their HubSpot owner email, then updates the matching contact's `hubspot_owner_id`.

For Google Cloud, enable the Google Calendar API, create a Web application OAuth client, and use:

```text
http://localhost:3000/api/connections/google/callback
```

The requested Google scopes are identity/email plus Calendar free/busy. Add your account as a test user if the consent screen is still in testing mode.

After restarting the stack, open the **Connections** section and connect each provider using the connector setup secret. Never commit `.env` or provider credentials. For a deployed instance, set `APP_URL` to the public HTTPS origin and register the equivalent HTTPS callback URLs with both providers.

## API

```bash
curl -X POST http://localhost:3000/api/route \
  -H 'content-type: application/json' \
  -d '{
    "externalId": "form-submission-123",
    "lead": {
      "email": "maya@example.com",
      "company": { "employee_count": 820, "state": "NY" }
    }
  }'
```

Reusing an `externalId` returns the original decision without consuming another round-robin assignment.

## Architecture

```text
lead payload
    │
    ▼
Next.js web + API ──► routing engine ──► PostgreSQL audit log
                            │                    │
                            ▼                    ▼
                 Google free/busy + W-RR  durable job queue
                                                 │
                                                 ▼
                                      HubSpot owner writeback
```

The monorepo separates the product surface from reusable routing and persistence packages:

```text
apps/web       operator UI and HTTP API
apps/worker    background job processor
packages/router pure routing domain logic
packages/db    schema, migrations, repository, seed data
packages/integrations provider contracts and development adapters
integrations/hubspot  source-controlled HubSpot OAuth app definition
```

See [architecture](docs/architecture.md), [decisions](docs/decisions.md), and [contributing](CONTRIBUTING.md) for more detail.

## Open source

The code is licensed under [AGPL-3.0-only](LICENSE). The Hot Potato name, mascot, and visual identity are covered separately by [TRADEMARKS.md](TRADEMARKS.md); the software license does not imply permission to present a modified service as the official Hot Potato product.

DayOtter and Cal.com were useful public architecture references. No third-party source code was copied into this initial implementation.
