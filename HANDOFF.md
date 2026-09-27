# Morning Handoff

## Finished

- Obsolete CRM owner-writeback jobs now finish as `superseded` without calling the provider; the existing dashboard preserves that outcome.
- A per-contact PostgreSQL lock holds through the provider callback, preventing an older in-flight write from overtaking a newer write.
- Added focused worker regressions and extended the existing database smoke with failed retry, superseded status, concurrent ordering and failure-release cases.
- CI now runs that smoke against disposable PostgreSQL. Public runtime `03916c4` includes the fix and a compatible Next.js/Sharp patch with zero reported audit vulnerabilities.
- README and decision notes explain the failure, correction and limits. Node setup instructions now build the integrations and worker packages missing from a fresh checkout. Unrelated local product changes were excluded from the public release.

## Try It

1. Run `docker compose up --build`, then open `http://localhost:3000`. Provider credentials are optional for the development adapter.
2. Run `npm test` for the router, adapters and worker checks.
3. With a disposable PostgreSQL database configured, run `npm run db:setup && npm run test:integration`. The smoke uses synthetic provider callbacks and makes no CRM requests.
4. For Node development, follow the README build steps before starting `npm run dev` and `npm run dev:worker`.

## Checks

- Clean install, 20 tests, workspace typecheck, formatting, production build and diff checks passed locally. `npm audit` reported zero vulnerabilities after the dependency patch.
- [CI for exact runtime `03916c4`](https://github.com/harrisonoconnorhover/hot-potato/actions/runs/36334701962) passed install, formatting, typecheck, tests, PostgreSQL setup, integration smoke and build.
- The database smoke confirmed old failure → newer success → old retry skipped, a persisted superseded dashboard status, and ordered concurrent writes.
- Local Docker was unavailable; the PostgreSQL verification above ran in GitHub CI. No live CRM/calendar workflow or previous OAuth evidence was rerun.
- A fresh source archive reproduced missing worker/integrations modules. The added package builds passed and the credential-free worker reached `Hot Potato worker ready`; an intentionally unavailable local database then stopped it. No full local Docker run was performed. Focused documentation formatting and diff checks passed.

## Decisions

- Compare monotonic job IDs within organization/contact; old retries must not undo newer queued assignments.
- Serialize only owner writes for the same contact and release the transaction lock on failure.
- Keep the public correction separate from the unpublished development backlog.

## Remaining

- Development mirrors `f6b761b` and `dbbe58c` passed 13 focused guard/calendar tests, 276 web tests, typecheck and build. Existing Outlook edits remain unchanged. That unpublished checkout retains one pre-existing high Nodemailer advisory; this public release reports none.
- This guard does not detect ownership edits made independently inside the CRM. Hosted/provider deployment is unchanged.

## Review First

- `packages/db/src/repository.ts`: current-owner guard and completion status.
- `apps/worker/src/owner-writeback.ts` and worker regression tests.
- `packages/db/src/integration-smoke.ts` and the linked CI run.
