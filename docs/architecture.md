# Architecture

Hot Potato begins as one deployable system with explicit package boundaries. It is not a collection of networked microservices.

## Request path

1. `POST /api/route` validates a lead payload and optional external ID.
2. The repository loads active rules, pools, representatives, schedules, assignment state, and eligible route candidates.
3. When Google is connected, the API checks the candidates' calendars and removes busy representatives. A provider failure stops the route rather than guessing.
4. The pure router selects the first matching rule, filters eligible reps, preserves a current owner when eligible, or selects the least-served weighted rep.
5. A pool-scoped PostgreSQL advisory lock serializes assignment state changes.
6. The decision, availability source, new assignment count, and CRM writeback job commit together.
7. The worker claims the job with `FOR UPDATE SKIP LOCKED`, refreshes OAuth tokens when needed, and invokes HubSpot or the development adapter.

External IDs are protected by their own transaction lock. Retried form submissions return the original decision rather than advancing the pool again.

## Boundaries

- `packages/router` has no database or framework dependency. Rules and selection can be tested deterministically.
- `packages/db` owns persistence and transactional coordination.
- `apps/web` owns validation, OAuth callbacks, Google free/busy checks, the HTTP surface, and operator experience.
- `apps/worker` owns asynchronous side effects, including HubSpot contact-owner writeback.
- `packages/integrations` owns encrypted token handling, refresh, and provider HTTP adapters.

## OAuth storage

Access and refresh tokens are encrypted with AES-256-GCM before PostgreSQL storage. The encryption key stays in the runtime environment. Installation starts require a separate setup secret because product user authentication is not part of this slice.

## Deployment

The required infrastructure is PostgreSQL. Web and worker processes can run together on a small host or scale independently. The reference Compose file is deliberately cloud-neutral. Provider credentials and OAuth callback origins are environment configuration, never seed data.
