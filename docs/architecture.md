# Architecture

Hot Potato begins as one deployable system with explicit package boundaries. It is not a collection of networked microservices.

## Request path

1. `POST /api/route` validates a lead payload and optional external ID.
2. The repository loads active rules, pools, representatives, schedules, and assignment state.
3. The pure router selects the first matching rule, filters eligible reps, preserves a current owner when eligible, or selects the least-served weighted rep.
4. A pool-scoped PostgreSQL advisory lock serializes assignment state changes.
5. The decision, new assignment count, and CRM writeback job commit together.
6. The worker claims the job with `FOR UPDATE SKIP LOCKED` and invokes the selected adapter.

External IDs are protected by their own transaction lock. Retried form submissions return the original decision rather than advancing the pool again.

## Boundaries

- `packages/router` has no database or framework dependency. Rules and selection can be tested deterministically.
- `packages/db` owns persistence and transactional coordination.
- `apps/web` owns validation, the HTTP surface, and operator experience.
- `apps/worker` owns asynchronous side effects. The first adapter is local; CRM providers plug in here.

## Deployment

The required infrastructure is PostgreSQL. Web and worker processes can run together on a small host or scale independently. The reference Compose file is deliberately cloud-neutral.

## Next connector slice

The first external connector milestone is HubSpot owner writeback plus Google Calendar free/busy. Provider credentials and OAuth callbacks will remain outside the routing package, and each route will retain the provider response in its audit trail.
