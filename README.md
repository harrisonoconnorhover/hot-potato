# Hot Potato

Open-source inbound lead routing and meeting scheduling for GTM teams.

Hot Potato connects lead qualification, explainable representative assignment, and meeting management. It matches the first eligible rule, preserves a valid owner when possible, finds time across configured Google and Outlook calendars, chooses an available rep with weighted round robin, and persists the decision and booking lifecycle. Configured adapters handle the calendar event, CRM writeback, and lifecycle notifications.

## Development status

The repository includes the booking lifecycle, calendar/CRM adapters, and Gmail/Outlook compose surfaces. Automated tests use fictional fixtures and mocked provider boundaries; PostgreSQL integration checks verify database behavior. Those checks do not establish successful delivery through real Google, Microsoft, HubSpot, SMTP, or email-client accounts.

This is a development release. Real-account OAuth, calendar invitations, email delivery, Gmail/Outlook client behavior, marketplace approval, and a production deployment still require separate qualification. See [release readiness](docs/release-readiness.md) for the verification boundary and local checks.

## Run it

The complete local stack needs Docker and one named owner credential in an
ignored `.env` file:

```text
HOT_POTATO_ADMIN_USER=owner@example.com
HOT_POTATO_ADMIN_NAME=Workspace Owner
HOT_POTATO_ADMIN_PASSWORD=use-at-least-12-characters
```

Then start it:

```bash
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000) and sign in. The compose stack starts PostgreSQL, applies migrations, creates one empty workspace and its named owner, runs the web/API process, and starts the job worker. Restarting it never reseeds workspace configuration or overwrites in-app password, role, or access-status changes. For intentional owner recovery, set `HOT_POTATO_RESET_ADMIN_PASSWORD=true`, run bootstrap once, then return it to `false`; recovery restores the configured owner role and access, replaces the password when needed, and revokes existing sessions.

To load the disposable Acme example instead, opt into the demo seed once before starting the stack:

```bash
docker compose --profile demo run --rm seed
docker compose up --build
```

The demo seed is intentionally separate because rerunning it restores its sample representatives, rules, meeting types, and links. Do not run it against a workspace you want to keep customized.

To work on the app with Node.js 22+:

```bash
npm ci
set -a
source .env
set +a
docker compose up -d postgres
npm run db:setup
npm run build --workspace @hot-potato/email-composer
npm run build --workspace @hot-potato/integrations
npm run build --workspace @hot-potato/worker
npm run dev
```

This loads the same ignored local configuration into the current shell; never use an untrusted `.env` file. In a second terminal, load the same `.env` as above before running `npm run dev:worker`. The package builds are required because a fresh checkout does not contain their generated JavaScript. After changing a shared package or worker source, rerun that package's build command. Use `npm run db:demo` instead of `db:setup` when you explicitly want the sample Acme records.

For short remote setup testing from a developer machine, use the authenticated [temporary Cloudflare tunnel](docs/local-tunnel.md). It is intentionally separate from production hosting.

## Implemented capabilities

- Priority-ordered conditional rules plus one explicit final catch-all
- Self-serve representatives, weighted pools, and human-readable rule editing
- Side-effect-free route previews with rule-by-rule and rep-by-rep traces
- Reusable named weeks, date-specific overrides, active-rep filtering, and current-owner preservation
- Per-rep daily and Monday–Sunday meeting limits in each rep's local timezone
- Transaction-safe weighted round robin with per-pool assignment state
- PostgreSQL decision history and idempotent external request IDs
- Postgres-backed jobs with retries and concurrent-worker-safe claiming
- Google OAuth, Calendar free/busy filtering, and direct event creation
- Microsoft Entra OAuth and Outlook free/busy filtering through Microsoft Graph
- Rep-owned Google and Outlook OAuth with direct, idempotent event creation
- Mixed Google + Outlook conflict checks with one explicit booking calendar
- Editable meeting types with preparation/recovery buffers, working hours, timezones, notice, and booking windows
- Collective meetings with fixed co-hosts and fair required/optional co-host pools
- Permanent rep and pool scheduling links with live calendar availability
- Smart Router Links that qualify a visitor before showing the matched calendar
- An operator Handoff Scheduler that qualifies, shows the matched rule and pool, and books a live rep-owned slot
- Responsive iframe embeds with a no-JavaScript link fallback
- Updated-editor HubSpot and manual form bridges that open only after verified success
- Native Gmail compose actions for booking links and mixed-calendar live times
- An Outlook compose task pane with Microsoft NAA identity and revocable pairing fallback
- Recipient-timezone slot selection and automatic calendar invitations
- Recipient cancellation and rescheduling without an operator handoff
- Google Meet and Microsoft Teams creation, plus configured Zoom room links
- SMTP confirmations, reschedule/cancellation notices, and scheduled reminders
- Time-filtered routing conversion, rep distribution, calendar delivery, and meeting-outcome reporting
- Named, role-aware operator login with revocable server-side sessions
- Owner-managed one-time invitations, member roles, access pausing, password resets, and personal session controls
- A rep-owned **My calendar** workspace for reusable or custom weekly availability, date-specific exceptions, split working periods, daily/weekly meeting capacity, timezone, Google/Outlook conflict calendars, booking provider, and the personal link
- HubSpot OAuth and queued contact-owner writeback after assignment
- A responsive operator workspace backed by the real routing API

Without a HubSpot connection, the development CRM adapter completes CRM jobs locally without updating an external CRM. Ownership-only routing can use weekly schedules before calendar connections exist; public meeting booking requires a ready rep-owned Google or Microsoft connection. Rep-owned calendar connections take priority: every named Google or Outlook calendar the rep selects is checked, while one explicit provider remains the booking destination and writes to Google primary or Outlook default. Reps without a booking calendar are held out of the route. Until any rep connects, the organization-level Google or Microsoft connection remains the fallback. HubSpot jobs write the selected owner to the contact matched by email.

## Manage workspace access

Owners and admins use **People & access** to invite named teammates, change roles, pause access, and issue one-time password-reset links. Only owners can grant or manage the owner role, nobody can change their own role or pause their own access, and the last active owner is protected. A role or active-status change revokes that teammate's existing sessions immediately.

Invitation and reset links expose the raw credential only once. PostgreSQL stores a SHA-256 hash, purpose, expiry, and revocation/use state; invitations expire after seven days and password resets after 30 minutes. Every teammate can use **My security** to change their password, see active browser sessions, and sign out any other browser. Changing a password keeps the current browser and revokes the rest.

Every teammate can also use **My calendar** when their login matches exactly one active representative email in the workspace. Missing or ambiguous normalized matches fail closed. Owners and admins retain workspace-wide calendar management; operators can read or change only their matching representative. Daily capacity resets at local midnight, weekly capacity runs Monday through Sunday, and blank limits remain unlimited. The same limits govern personal links, pooled links, Smart Router and embedded flows, Handoff, Gmail, Outlook, and managed rescheduling. The operator dashboard omits admin-only representative, pool, meeting-type, and form-bridge records while keeping the routing and Handoff data needed for daily work.

## Configure and test routing

Open **Routing studio** to add or edit representatives, weighted pools, and priority-ordered rules without changing seed files. Rule conditions support nested field paths and the `equals`, `in`, `at least`, `at most`, `contains`, and `exists` operators. Add one catch-all to route every lead that misses the conditional rules; Hot Potato always evaluates it last regardless of its stored audit priority.

Use **Test a route** before sending live traffic. The preview evaluates every rule condition and representative, shows the predicted winner, and uses the same owner-preservation and weighted-selection logic as a live route. It is deliberately read-only: previews do not persist a decision, advance assignment state, queue CRM writeback, or contact a calendar provider.

## Publish a Smart Router Link

Open **Smart links**, create a link, and use **Sync with active rules** to turn the fields used by your routing rules into buyer-friendly questions. Map every reachable pool to an active pool meeting type. Hot Potato checks that the questions, meeting destinations, connected calendars, and conferencing providers are ready before it allows the link to be published.

A published link uses this readable shape:

```text
http://localhost:3000/r/acme/enterprise-demo
```

The buyer submits their name, work email, and qualification answers, then sees only the live calendar for the first matching rule. Hot Potato does not expose the internal rule, pool, or representative before a time is selected. If the conditional rules miss, an active catch-all can show its configured pool calendar; without one, the buyer sees the safe follow-up message configured in the editor.

To embed the same flow, copy the generated snippet from **Readiness and deploy** or use:

```html
<div data-hot-potato-router="https://hot-potato.example/r/acme/enterprise-demo">
  <a href="https://hot-potato.example/r/acme/enterprise-demo">Book a meeting</a>
</div>
<script async src="https://hot-potato.example/embed/v1.js"></script>
```

The loader creates a sandboxed, responsive iframe and keeps the ordinary link as a fallback if scripts or the embed fail. It supports multiple embeds and dynamically added embeds on one page. Host pages may listen for `hotpotato:ready`, `hotpotato:step`, `hotpotato:booked`, `hotpotato:no_slots`, `hotpotato:disqualified`, `hotpotato:closed`, and `hotpotato:error`; event details never include the buyer's answers or identity. A Smart Link may continue a confirmed buyer to one saved HTTPS URL after a 1–30 second confirmation window. Embedded hosts receive the cancelable `hotpotato:booked` event before that navigation and can call `event.preventDefault()` when their own application owns the next step.

### Bridge an existing form to the matched calendar

Open **Existing forms**, choose a published Smart Router Link, map the source fields you already collect, add each exact website origin, and save the bridge. The generated marker and the same `/embed/v1.js` loader can sit anywhere on that page:

```html
<script src="https://hot-potato.example/embed/v1.js"></script>
<div data-hot-potato-form-bridge="4e487f82-458e-4c13-a8c4-37e59455f1ae"></div>
```

For a form created in HubSpot's updated editor, enter the exact form ID and load this snippet before HubSpot's form embed. The loader uses HubSpot's official [`hs-form-event:on-submission:success`](https://developers.hubspot.com/docs/api-reference/latest/marketing/forms/global-form-events) event and reads that event's form instance; updated-editor field names look like `0-1/firstname` and `0-2/numberofemployees`. Disable the HubSpot form redirect so the matched calendar can remain on the page; configure any post-booking continuation on the Smart Link so it cannot fire before the Google or Outlook write is confirmed. Legacy HubSpot forms and other providers use the manual API after their callback, server, or SDK confirms persistence:

```js
await window.HotPotatoForms.open(bridgeId, {
  submissionId: result.id,
  values: Object.fromEntries(new FormData(form)),
});
```

`values` uses source-form field names; Hot Potato forwards only the configured name, email, and routing mappings. The submission ID makes duplicate success callbacks harmless after the scheduler accepts the handoff, while a pre-load timeout can retry the same verified submission. After acceptance, closing the modal suspends that exact iframe and adds **Resume scheduling** beside the original form; reopening it does not requalify the visitor, resend identity, or require the source form to fire again. The returned promise reports whether the scheduler opened, not whether the visitor ultimately booked. The loader never puts identity or answers in a URL or browser event, accepts only the configured HTTPS origins, and leaves the original thank-you untouched if config, mapping, or scheduling fails. Editing a Smart Link invalidates its saved bridges until their mappings are reviewed and saved again.

Qualification sessions are short-lived and stored by an opaque token hash. Public JSON bodies are capped, public actions use PostgreSQL-backed IP/session/email limits, and every booking rechecks live availability. A durable, time-bounded attempt marker is acquired before provider reads, so a reload or duplicate click sees the exact in-flight time instead of starting a second request. Assignment, the routing decision, the booking, the round-robin counter, CRM writeback, and calendar work are committed together once after a time is selected. Retrying the same session returns the existing booking instead of assigning twice.

The worker removes expired unbooked qualification sessions, expired rate-limit buckets, and expired or old consumed calendar OAuth attempts each hour. Once a booked session is 24 hours old, its duplicate name, email, lead payload, and request fingerprint are redacted; the durable booking and routing records remain available to the operator under their normal business retention policy.

## Hand off a qualified buyer live

Open **Handoff scheduler**, choose a published Smart Router Link, and enter the buyer details using that link's current questions. Qualification is read-only: it shows the matched rule, pool, and meeting type without assigning a representative. Hot Potato then combines the eligible pool's working hours with every selected Google and Outlook conflict calendar in the operator's browser timezone.

Choose a live time and select **Assign rep & book**. Hot Potato rechecks the slot, assigns one eligible rep, writes the routing decision and CRM work together, creates the rep-owned calendar event and conferencing, invites the attendee, and returns the meeting and private management links. A stale time refreshes without losing the qualification. Reload recovery keeps only an opaque capability, stable Smart Link identity, chosen time, and safe match labels—never the buyer's identity or answers—and follows the same link through a rename or unpublish.

If Google or Outlook reaches its terminal retry limit, the same rep, time, and routing decision stay reserved on the same booking. **Retry same booking** first looks up Hot Potato's provider transaction: it reuses an event that already exists, or fresh-checks the assigned rep's exact time before requeuing the same write. **Close failed booking** starts a conservative reconciliation: a found event is removed, while an absent event must remain absent across a quiet period and two separated checks before the time is released. Normal scheduling links run that same reconciliation automatically. The ownership-only **Routing API tester** remains separate and never presents itself as a meeting scheduler.

The recipient management page applies the same rule to a provider timeout during rescheduling. Both the original and requested ranges remain reserved, the page explains the uncertain change, and **Retry this reschedule** reuses the exact provider event and requested time instead of starting a different change.

## Monitor routing and meeting outcomes

Open **Reporting** to review the last 24 hours, 7 days, 30 days, or 90 days. The funnel counts a submission when Smart Router qualification succeeds and a booking when that same qualified session creates a durable booking. It keeps those conversion totals after short-lived buyer sessions are deleted or redacted, without retaining a second copy of the buyer's name, email, or answers.

The dashboard separates routing demand from calendar delivery: **booked** means Hot Potato reserved the meeting and created its lifecycle work, while Google Calendar or Outlook **confirmed** means the provider write completed. Per-link conversion, representative assignment share, provider failures, cancellations, and no-shows remain visible as distinct signals instead of being collapsed into one success rate.

Past confirmed meetings can be marked **Attended** or **No-show** from the recent activity list, and that outcome can be corrected or cleared. Pending, failed, cancelled, and future meetings cannot be given an attendance outcome. Reporting and attendance APIs use the same protected operator boundary as the rest of the workspace; public scheduling pages cannot read them.

## Connect HubSpot, Google Calendar, and Microsoft 365

Copy `.env.example` to `.env` and configure the required local secrets using the instructions in that template.

The current HubSpot developer-platform app definition is versioned in [`integrations/hubspot`](integrations/hubspot). Upload it with the HubSpot CLI, then place its client ID and secret in `.env`. It requests this redirect URL:

```text
http://localhost:3000/api/connections/hubspot/callback
```

Grant `oauth`, `crm.objects.contacts.read`, `crm.objects.contacts.write`, and `crm.objects.owners.read`. Existing installs must reconnect once to grant contact read access. Before direct routing, Smart Router qualification, or form handoff, Hot Potato looks up the contact by email and resolves its current HubSpot owner server-side; a caller-supplied owner is never trusted. A missing contact or unassigned owner routes normally, while a connected HubSpot account that cannot verify ownership fails closed instead of silently rerouting the buyer. After booking, Hot Potato resolves the selected representative by HubSpot owner email and updates the contact's `hubspot_owner_id` through the queued worker. A rotating co-host role may also name a unique custom HubSpot user property, such as `technical_owner`; after the booking chooses that role, a separate queued job verifies that every configured field is a writable user property, resolves the selected people to owner IDs, and writes all role fields in one contact update. Create those fields as HubSpot user properties and enter their internal property names.

For Google Cloud, enable the Google Calendar API, create a Web application OAuth client, and register both exact callback URLs:

```text
http://localhost:3000/api/connections/google/callback
http://localhost:3000/api/rep-connections/google/callback
```

The organization connector requests identity/email plus Calendar free/busy. A rep who uses **Connect Google** grants Calendar free/busy, read-only CalendarList discovery, and event access so Hot Potato can check the rep's selected calendars while writing confirmed bookings only to Google primary. Existing rep connections created before named-calendar support must reconnect once to grant the discovery scope. Add each development account as a test user while the Google consent screen is in testing mode.

For Microsoft 365 and Outlook.com, create a multitenant web app in Microsoft Entra using the settings in [`integrations/microsoft`](integrations/microsoft), then use:

```text
http://localhost:3000/api/connections/microsoft/callback
```

The organization-level connector requests identity, refresh-token, and delegated `Calendars.ReadBasic` access. Work and school accounts can supply multi-representative free/busy through Microsoft Graph. Personal Outlook.com accounts can authenticate, but Microsoft does not expose `getSchedule` to delegated personal accounts, so they are recorded without becoming the active routing calendar. That shared connector does not request calendar write access.

For rep-owned Outlook calendars, also register:

```text
http://localhost:3000/api/rep-connections/microsoft/callback
```

Admins can connect any representative in **Calendar readiness**; each matched teammate can manage their own account in **My calendar**. Teammates can select a workspace reusable week or keep custom weekly availability in their own timezone, including up to four non-overlapping periods per day, one-click Monday copies, and up to 120 date-specific exceptions. An exception can block a vacation day or open custom hours and always takes priority over the assigned or custom week. Those hours immediately govern personal and pool links, Smart Router Links, Handoff, Gmail, Outlook, and rescheduling; selected calendars still remove busy time inside them. New connections check the provider default for conflicts, and a calendar refresh reveals the account's other owned calendars as individual choices. A rep can select named calendars across both providers and separately choose which provider receives new events. The active provider's Google primary or Outlook default is always checked and cannot be turned off. Reconnecting the same account preserves those choices; connecting a different account resets that provider's catalog so opaque IDs never carry across accounts.

Rep OAuth start requests require the signed-in operator, the exact application origin, and current representative scope. The callback consumes a one-time PostgreSQL attempt bound to that organization, operator, rep, provider, and return surface by a SHA-256 OAuth-state hash; browser cookies retain only state and PKCE proof, never the authoritative rep ID. Replays, expired attempts, changed access, missing sessions, and tampered state fail closed before token exchange. Handoff bookings always invite the qualified attendee through the normal booking lifecycle; the separate ownership-only API tester creates no calendar event.

## Configure and share scheduling links

Use **Meeting types** to control the public slug, title, duration, invisible preparation and recovery buffers, minimum notice, booking window, buyer guardrails, change deadlines, conferencing, reminder timing, and whether a link is active. A buyer guardrail can cap active or upcoming bookings per normalized email or exact domain; direct links, Smart Router Links, embeds, and Handoff enforce it inside the same concurrency-safe booking transaction. Rescheduling and cancellation can close independently from one week before the meeting through its start, or remain available at any time. Each booking snapshots those deadlines so a later setting edit cannot rewrite an existing buyer's management rights. A meeting type can target one rep or an entire routing pool. Add up to ten fixed co-hosts or five rotating pool roles. A required fixed person narrows availability directly; a required pool needs at least one free member, while optional people and pools are assigned and invited without blocking the buyer's choices. Each rotating role can optionally map its selected person into a unique HubSpot contact owner property without putting CRM latency in the booking path. Required participants must have ready Google or Outlook conflict calendars, and Hot Potato rejects configurations that cannot produce a distinct person for every role. In **Working hours**, admins can build named weekly schedules, assign one across many reps, and update every assignment atomically. Removing a template detaches its reps without changing their last effective hours. Each rep can also stay custom, choose their timezone, and maintain personal date overrides. The shared validation preserves multiple periods, rejects overlap and impossible dates, sorts schedules before storage, and warns when an all-unavailable week would leave every booking surface without times.

Every connected rep still has **Preview** and **Copy link** actions in **Rep pools**. Meeting-type URLs use the same readable organization and link slugs:

```text
http://localhost:3000/schedule/acme/ada-chen
http://localhost:3000/schedule/acme/enterprise-intro
```

For a rep link, the recipient sees times allowed by that rep's working hours and free across every Google and Outlook calendar the rep selected for conflicts. For a pool link, Hot Potato unions the eligible reps' live availability, then assigns one available rep with the pool's weighted round robin when the recipient books. Times display in the recipient's browser timezone.

Collective scheduling composes with both targets. Hot Potato intersects each candidate organizer with every required fixed co-host and at least one candidate from each required co-host pool, including working hours, date overrides, selected Google and Outlook calendars, existing reservations, and local capacity. Pool roles retain their own weighted assignment state, choose distinct people with a fair backtracking match, and serialize pool locks in stable order. The booking transaction reserves all required participants together, so the same person cannot be double-booked across roles. It snapshots the selected team and source pools so later membership or meeting-type edits do not silently change an existing invitation or managed reschedule.

Buffers reserve real time around each meeting without creating fake calendar events or exposing internal setup time to recipients. Hot Potato applies them to public links, Smart Router Links, Handoff, Gmail, Outlook, and rescheduling; each booking snapshots the policy it was created with so later meeting-type edits cannot move an existing reservation.

On booking, Hot Potato rechecks availability and queues the provider event. The booker can invite up to five additional guests from personal links, Smart Router Links and embeds, or Handoff; addresses are normalized and deduplicated, while only the primary booker receives Hot Potato lifecycle email and the private management link. Additional guest availability is not checked. Google Calendar and Outlook send native invitations and updates to the organizer's co-host team and the full guest list, including when the organizer and a required co-host use different providers. For Google Meet and Microsoft Teams, Hot Potato verifies a usable join URL before adding anyone or reporting success, performs bounded re-reads while Google finishes asynchronous Meet creation, and cleans up terminal conference or attendee-finalization failures. Zoom meeting types use a configured `zoom.us` room link in this release; unique per-booking Zoom meetings would require a separate Zoom OAuth integration.

The confirmation page includes a private management link. From it, the recipient can reschedule with the same rep or cancel until that booking's saved deadline; closed actions explain when the window ended, and the server repeats the cutoff check under the booking lock. Hot Potato updates or removes the provider event and sends the corresponding notification. Configure `SMTP_HOST` and `SMTP_FROM` (plus the optional credentials in `.env.example`) to deliver confirmation, reminder, reschedule, and cancellation emails. Without SMTP, the development adapter records the recipient and subject in worker logs without sending email; use fictional addresses for local tests. A connected calendar provider can still send native invitations even when SMTP is disabled. `WORKER_OPERATION_TIMEOUT_MS` defaults to two minutes and is capped below the five-minute reclaim window, so a late Google or Microsoft request is aborted before another worker may own that job.

Hot Potato keeps four identities deliberately separate: a caller's idempotency key, the recipient's random management capability, the provider transaction, and the exact connected calendar account that owns the event. Availability quotes bind the representative, provider account, and selected conflict calendars to the booking transaction. Reconnecting a different known account is blocked while the old account owns a future or unresolved meeting, and legacy rows with unknown ownership remain read-only until exact provider evidence proves the account, event, and time range.

After restarting the stack, sign in as an owner or admin, open **Connections**, and connect each provider. The named session replaces the old duplicate connector setup secret; OAuth still uses short-lived state and PKCE where supported. Never commit `.env` or provider credentials. For a deployed instance, set `APP_URL` to the public HTTPS origin and register the equivalent HTTPS callback URLs with every provider.

## Insert scheduling from Gmail and Outlook

Open **Email scheduling** in the operator workspace. Both email clients use the same active meeting types, Smart Router Links, mixed Google/Outlook conflict checks, collective co-host intersections, and email-safe renderer. The email client and booking calendar are independent: Gmail can suggest time from Outlook Calendar, Outlook can suggest time from Google Calendar, and reps with both connected get both checked before a time is offered.

Hot Potato remembers that representative's most recent valid booking-link choice and live-time meeting separately. Gmail preselects both on the next compose action; Outlook records successful inserts or copies, reopens the last successful format, and never starts a Smart Router Link in the unsupported live-times mode. Inactive or inaccessible assets are ignored automatically, and a preference-write failure never blocks scheduling insertion.

For Outlook, configure Microsoft Entra nested app authentication (NAA) with Hot Potato's own delegated `access_as_user` scope and set `OUTLOOK_NAA_CLIENT_ID`. The task pane silently uses the Microsoft account already signed in to Outlook, then falls back to a popup or Office dialog when needed. The server validates the access token's signature, version, audience, issuer, tenant, authorized client, scope, and expiry, then resolves the stable tenant-and-subject identity through a durable representative binding. The first connection proves that binding with one active rep-scoped fallback key. This identity app requests no Graph or mailbox-reading permission; Outlook calendar OAuth remains separate.

Owners and admins can also create rep-scoped fallback pairing keys for older clients or recovery. A raw key is shown once, only its SHA-256 hash is stored, and the pane keeps the key only in session storage—never Office roaming settings. It can read only that rep's shareable scheduling assets, is rate-limited, and can be revoked without disconnecting a calendar; revocation also disables the Microsoft identity bootstrapped through that key. The task pane detects HTML versus plain-text drafts, inserts at the current selection or cursor, and retries with plain text if Outlook rejects the HTML fragment. Render and sideload the least-privilege `ReadWriteItem` manifest from [`integrations/outlook`](integrations/outlook); a public release still requires real-client qualification and Microsoft Marketplace review.

For Gmail, configure these values separately from Google Calendar OAuth:

```text
GOOGLE_WORKSPACE_ADDON_OAUTH_CLIENT_ID=
GOOGLE_WORKSPACE_ADDON_SERVICE_ACCOUNT_EMAIL=
```

Deploy the HTTP add-on template in [`integrations/google-workspace`](integrations/google-workspace). Google signs every request twice: a system ID token authenticates the exact HTTPS endpoint and a user ID token supplies a verified email. Hot Potato maps that email to exactly one active rep and fails closed on missing or ambiguous matches. The manifest uses `draftAccess: NONE` and requests no message, recipient, or broad Gmail scope; the add-on is designed to insert editable HTML in Gmail web, iOS, and Android; the real-client matrix in its integration guide remains a release qualification requirement.

Live-time suggestions are explicit-timezone snapshots, never reservations. Gmail and Outlook offer up to 12 current choices, preselect three across different days when possible, and let the sender choose one to five. Before choosing times, the sender can select the recipient-facing timezone from the same shared list in either client; Gmail refreshes the card immediately and Outlook refreshes any open choices. This is a manual presentation choice—Hot Potato does not read recipients, guess a location, or use enrichment.

The server rebuilds the labels and fresh-checks every selected time in that chosen timezone before rendering; if one filled, nothing is inserted and the picker returns fresh alternatives. Each option points to the ordinary scheduling page with a `?time=` hint, where availability is checked again before confirmation. Email scanners therefore cannot create meetings, and final booking still requires a deliberate POST plus the existing live calendar recheck.

Public rate limits ignore forwarding headers by default, which deliberately gives direct-origin traffic one shared abuse bucket. Behind a reverse proxy, set `TRUSTED_PROXY_CLIENT_IP_HEADER` only when the origin is inaccessible except through a proxy that overwrites that exact header. The reference Compose ports bind to `127.0.0.1`; a per-link booking ceiling remains in force even when per-client addressing is configured.

## API

Use the signed-in **Routing API tester** to send an ownership-only route request. It creates a routing decision and queues CRM work; it does not create a calendar event. A connected HubSpot account can receive that queued write, so use fictional fixtures in a disposable local workspace for development.

The request body for `POST /api/route` is:

```json
{
  "externalId": "form-submission-123",
  "lead": {
    "email": "maya@example.com",
    "company": { "employee_count": 820, "state": "NY" }
  }
}
```

The endpoint requires the current operator session; the workspace sends it as a same-origin request. Unauthenticated requests are rejected. Reusing an `externalId` returns the original decision without consuming another round-robin assignment.

## Architecture

```text
lead payload
    │
    ▼
Next.js web + API ──► routing engine ──► PostgreSQL audit log
                            │                    │
                            ▼                    ▼
        org or rep-owned calendar availability  durable job queue
                                                 │
                                      ┌──────────┴──────────┐
                                      ▼                     ▼
                            HubSpot owner writeback   Calendar event creation
```

The monorepo separates the product surface from reusable routing and persistence packages:

```text
apps/web       operator UI and HTTP API
apps/worker    background job processor
packages/router pure routing domain logic
packages/email-composer browser-safe selection, safe markup, and host bridge contracts
packages/db    schema, migrations, repository, seed data
packages/integrations provider contracts and development adapters
integrations/hubspot  source-controlled HubSpot OAuth app definition
integrations/microsoft Microsoft Entra registration settings
integrations/google-workspace Gmail HTTP add-on deployment template
integrations/outlook least-privilege Outlook compose manifest and icons
```

See [architecture](docs/architecture.md), [decisions](docs/decisions.md), [temporary remote testing](docs/local-tunnel.md), and [contributing](CONTRIBUTING.md) for more detail.

## Open source

The code is licensed under [AGPL-3.0-only](LICENSE). The Hot Potato name, mascot, and visual identity are covered separately by [TRADEMARKS.md](TRADEMARKS.md); the software license does not imply permission to present a modified service as the official Hot Potato product.

DayOtter and Cal.com were useful public architecture references. No third-party source code was copied into this initial implementation.
