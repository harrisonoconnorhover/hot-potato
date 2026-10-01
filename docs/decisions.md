# Product and engineering decisions

These dated notes record the product's evolution. Later decisions supersede earlier ones; use the [README](../README.md), [architecture](architecture.md), and [release readiness](release-readiness.md) for current setup and qualification boundaries.

## 2026-09-27 — Keep obsolete owner retries from undoing newer assignments

Owner writebacks take a PostgreSQL transaction lock for the organization/contact and compare queued job IDs before calling the provider. Obsolete jobs finish as `superseded`; in-flight writes for that contact complete in order. Claim-token fencing and cancellation still protect each worker's lifecycle. This prevents stale Hot Potato retries from undoing newer Hot Potato assignments; it does not detect independent ownership edits inside the CRM.

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

## 2026-08-24 — Encrypt refreshable OAuth connections

HubSpot and Google use authorization-code OAuth with refresh tokens. Access and refresh tokens are encrypted before storage with an environment-held AES-256-GCM key. A separate setup secret protects connector installation until full product authentication exists.

## 2026-08-24 — Fail closed on connected-calendar errors

Weekly schedules remain the local fallback when Google is not connected. Once it is connected, a failed or ambiguous free/busy lookup stops the route rather than assigning a representative whose availability was not verified.

## 2026-08-24 — Keep CRM writeback asynchronous

The routing decision commits before the external HubSpot call. The worker refreshes the token, resolves the selected representative by HubSpot owner email, and patches the contact by lead email. Retries remain visible in the existing durable job record.

## 2026-08-24 — Version the HubSpot app with the product

The HubSpot OAuth app uses the current 2026.03 developer platform and lives in `integrations/hubspot`. It is configured for marketplace distribution so the same source-controlled app can support additional customer accounts later. The HubSpot CLI key is intentionally limited to developer-project uploads; CRM access belongs only to the installed OAuth app.

## 2026-08-24 — Keep one active calendar per organization for v0.1

Organizations can authorize both Google Calendar and Microsoft 365, but the most recently authorized free/busy-capable calendar supplies availability. This makes the current organization-scoped token model explicit and reversible. Per-representative calendar connections are deferred until product user authentication exists.

Microsoft uses a multitenant Entra web application that accepts work, school, and personal Microsoft accounts through the `common` OAuth authority. It uses authorization code flow with PKCE and delegated `Calendars.ReadBasic` access. Hot Potato reads multi-representative free/busy through Microsoft Graph for organizational accounts and does not request calendar write access. Microsoft does not support delegated `getSchedule` for personal accounts, so a personal connection is retained but cannot become the active routing calendar.

## 2026-08-24 — Let each rep own their calendar authorization

Rep-level Google and Microsoft connections are stored separately from organization connectors. Google requests delegated Calendar free/busy and event access; Microsoft requests delegated `Calendars.ReadWrite`. Hot Potato does not request tenant-wide application permissions. Once a pool begins using rep-level calendars, disconnected or unverifiable reps are held out of routing rather than guessed available. The organization-level connector remains a backwards-compatible fallback until the first rep connects. The later mixed-conflict-calendar decision expands reads to every connection the rep selects while retaining one write destination.

Calendar writes stay asynchronous in the existing PostgreSQL job queue. A client-supplied external ID makes retries idempotent, and availability is rechecked immediately before enqueueing. Lead invitations are opt-in so local tests cannot accidentally email a real person.

## 2026-08-24 — Make public scheduling links rep-owned and permanent

Public links use readable `/schedule/{organization}/{rep}` paths and resolve only active, scheduling-enabled reps with a selected Google or Microsoft calendar. The public profile excludes rep email, tokens, and private provider event links.

Availability combines the rep's weekly schedule with live Google or Outlook busy intervals, then displays the result in the recipient's browser timezone. A public booking always includes the recipient as an attendee; it rechecks the chosen slot, uses an idempotent external UUID, and relies on a unique rep-and-start-time database constraint to close concurrent booking races.

The recipient surface is separate from the operator workspace. Before public application hosting, Hot Potato still needs product authentication for operator routes and production abuse controls such as rate limiting or Turnstile for the public booking endpoint.

## 2026-08-24 — Select one active rep calendar explicitly

A rep may retain both Google and Microsoft authorizations, but exactly one provider receives bookings. Completing a new connection makes that provider active; background token refresh never changes the selection. The later mixed-conflict-calendar decision supersedes the single-provider availability rule: selected connections now all block busy times while the active provider remains the event destination.

Google events use the booking transaction ID to derive a deterministic provider event ID. A retried worker can therefore recover the original event instead of creating a duplicate, matching the existing Microsoft idempotency behavior.

## 2026-08-24 — Gate temporary operator tunnels at the application edge

Cloudflare Quick Tunnels provide a free, short-lived URL before Hot Potato owns a Cloudflare-managed domain. When temporary admin credentials are configured, the Next.js proxy requires HTTP Basic authentication for the operator workspace and its mutation/read APIs. Localhost development remains unchanged when both values are absent.

Public scheduling pages and their booking API stay outside this gate because recipients must be able to use them. This is a setup-testing measure, not product authentication: a stable deployment still requires named user sessions, authorization, and abuse controls.

The 2026-08-31 named operator session decision below supersedes this temporary Basic-authentication boundary.

## 2026-08-26 — Make meeting types the scheduling contract

A meeting type owns its public slug, duration, notice, booking window, conferencing, reminder policy, active state, and either a rep or pool target. Pool pages publish the union of eligible reps' live availability and apply the existing weighted round robin only after a recipient selects an offered time. Rescheduling keeps the original rep so an attendee never changes hosts unexpectedly.

Bookings are durable product records rather than calendar-job aliases. Their lifecycle drives create, update, cancel, confirmation, and reminder jobs. The public management token is stored only as a SHA-256 hash; the browser receives no provider token, rep email, or private event-management URL.

## 2026-08-26 — Use native conferencing and portable email

Google Meet and Microsoft Teams links are generated by their native calendar APIs. Zoom meeting types accept a validated `zoom.us` room URL and attach it to the calendar event; unique Zoom meetings are deliberately deferred until a Zoom OAuth adapter is justified.

Notifications use ordinary SMTP so self-hosters are not tied to an email vendor. Production sends require `SMTP_HOST` and `SMTP_FROM`; otherwise the development adapter logs only delivery metadata. Calendar invitations remain provider-native and do not depend on SMTP.

## 2026-08-30 — Make routing configuration self-serve before adding embeds

Hot Potato's next adoption gate is a first-party Routing Studio for representatives, pools, ordered rules, and safe decision previews. The engine and scheduling lifecycle were already real, but a fresh self-hosted workspace still depended on seed data for its core routing configuration.

Configuration updates preserve referenced records: representatives and rules are deactivated instead of deleted, pools keep their identity, and existing route decisions remain explainable. New representatives receive a default meeting type so their readable scheduling slug has a valid lifecycle from creation.

The preview path uses the same pure rule, schedule, owner-preservation, and weighted-selection logic as a live route, but it never writes a decision, advances assignment state, queues a job, or contacts a provider. Live calendar exclusion stays in the live route; the studio labels preview results as a configuration simulation at the selected evaluation time.

## 2026-08-30 — Commit routing only when a Smart Link time is booked

A Smart Router Link uses two phases. Qualification validates only the questions configured for the link, finds the first matching rule, and creates a short-lived opaque session. It does not select a representative, advance weighted assignment state, save a routing decision, or write to HubSpot. This keeps an abandoned form from consuming ownership and prevents a preliminary route from disagreeing with the host who is actually free.

After the buyer selects a freshly checked slot, one PostgreSQL transaction locks the session and pool, selects from the representatives who still own that live slot, creates the routing decision and booking, advances assignment state once, and queues one CRM job and one calendar job. A unique session-to-booking relationship makes retries return the existing result. Provider availability remains an external point-in-time check, so a provider-side conflict can still surface as a failed calendar job instead of an unsafe duplicate database booking.

## 2026-08-30 — Make the embed an iframe with a durable link fallback

The public form-to-meeting experience is one first-party route used both standalone and inside a sandboxed iframe. The small versioned loader accepts an absolute Smart Link URL, preserves its ordinary anchor as a no-JavaScript/failure fallback, supports multiple and dynamically inserted mounts, and resizes only after validating the message source, origin, version, event shape, and height bounds.

Cross-frame events expose readiness, step, booking, error code, and height only—never identity, answers, rule, pool, or session token. The public APIs accept no broad cross-origin requests; the iframe calls its own origin. Database-backed rate limits, bounded request bodies, short-lived hashed sessions, bounded calendar checks, and a booking-time availability recheck form the v1 abuse and concurrency boundary.

The worker deletes expired unbooked sessions and expired rate-limit buckets hourly. Booked sessions keep their opaque status lookup but redact duplicate qualification PII after 24 hours; the booking and routing decision remain the durable business records. An optional challenge widget remains later hardening for sustained high-volume traffic.

## 2026-08-30 — Separate conflict calendars from the booking calendar

A representative may connect Google and Outlook at the same time. Each new connection is selected for conflict checks by default, while exactly one active provider remains the write destination for events and native conferencing. The active booking calendar is always part of conflict checks and cannot be excluded; reconnecting a provider preserves the representative's existing choice.

Routing, public scheduling, Smart Links, operator booking, and rescheduling fail closed when any enabled provider connection cannot verify its Google primary calendar or Outlook default calendar. Secondary calendars were deferred at this stage and are added by the later named-calendar decision. Outlook treats `free`, `workingElsewhere`, and cancelled events as available; tentative, busy, out-of-office, and unknown states remain blocking. Time-only provider updates omit attendees and bodies so a reschedule cannot erase guests or meeting details added directly in Google Calendar or Outlook.

Native conferencing is part of booking success, not optional metadata. Google Meet creation uses bounded event re-reads because Google may return a pending conference; Microsoft Teams create and update operations must return a join URL. New native-conference events withhold attendees until that URL is verified, then add the guest in a second provider update. A terminal conference or guest-finalization failure triggers best-effort event cleanup and keeps the calendar job from confirming the booking.

## 2026-08-30 — Keep email clients thin and scheduling provider-neutral

Gmail and Outlook are insertion surfaces, not new scheduling engines. Both receive the same minimal catalog, mixed-calendar availability, deterministic suggested-slot selection, safe HTML/plain text, and public booking URLs. Smart Router Links remain link-only because qualification determines the eventual meeting type and representative.

Suggested times are snapshots rather than holds. Their URLs contain one UTC `time` hint and no recipient data; GET remains side-effect-free. The public scheduler preselects an exact still-live option and otherwise explains that it filled before showing current availability. Final booking retains its deliberate POST, rate limit, live provider recheck, and database uniqueness boundary.

## 2026-08-30 — Use official compose extension points with least privilege

Gmail uses a Google Workspace HTTP compose add-on instead of Gmail DOM automation. The endpoint verifies Google's system and user ID tokens, handles Google's required granular-consent replay before identity lookup, maps verified email to exactly one active representative, uses `draftAccess: NONE`, and requests only add-on execution, current compose action, email identity, and locale scopes. This supports Gmail web and mobile without reading the draft or relying on unstable selectors.

Outlook uses an add-in-only XML compose task pane with `ReadWriteItem`, never `ReadWriteMailbox` or Graph mail scopes. The initial self-hosted slice used a random, hashed, rep-scoped, revocable pairing key while named operator sessions and Microsoft identity were not yet available. The raw key stays in task-pane session storage rather than insecure Office roaming settings, and it exposes only shareable scheduling assets. The later NAA decision makes verified Microsoft identity primary while retaining this key as a recovery path; calendar OAuth remains separate in every case.

## 2026-08-30 — Attach scheduling only after an existing form succeeds

Existing-form bridges listen after the source system confirms a successful submission; they do not replace validation, consent, persistence, analytics, or the site's ordinary thank-you. Forms created in HubSpot's updated editor use its official global success event and exact form ID. Legacy HubSpot forms and other systems use a small manual API whose caller supplies a stable submission ID after verified success.

Each bridge is pinned to one Smart Link configuration and an exact source-field map. Editing the link invalidates the public bridge until an operator reviews it. The cross-origin config is deliberately minimal, origins are exact HTTPS values (with loopback HTTP only for development), and the iframe route re-authorizes the bridge ID, Smart Link path, and parent origin before accepting a handoff. Mapped identity and answers then move directly to the sandboxed iframe through an origin- and window-bound message—not URLs, custom events, or storage. Duplicate callbacks are ignored after the iframe accepts the handoff; a transient config or pre-ready iframe failure releases that submission ID for a safe retry. Every failure leaves the source form's success experience in place.

## 2026-08-30 — Discover named calendars, but keep one write destination

Each rep connection now owns a normalized catalog of provider calendars. Google uses least-privilege CalendarList discovery and FreeBusy reads; Microsoft uses the existing delegated calendar permission to list owned calendars and read each selected calendar view. The Google primary and Outlook default are stored as stable provider-specific sentinels, while secondary provider IDs remain opaque. Successful refreshes preserve selections, mark disappeared calendars stale, and restore them if they reappear. A selected stale calendar makes the rep unavailable until repaired rather than risking a double-booking.

Calendar selection affects reads only. Google events continue to use the primary calendar and Microsoft events continue to use the default calendar. The active provider's default calendar is always selected for conflicts; an inactive provider may have no selected calendars. Connecting a second provider no longer changes the booking destination, same-account reconnects preserve selections, and a changed external account clears the old catalog so IDs never cross account boundaries.

## 2026-08-31 — Make the booking record the only slot ledger

Every meeting surface uses the durable `bookings` lifecycle. A background calendar job records delivery work and provider evidence, but its historical presence cannot reserve a time after cancellation or terminal failure. Active booking time ranges, including partial overlaps, are rejected at the database boundary and reinforced by the existing per-representative transaction lock.

The operator Handoff Scheduler now qualifies through a published Smart Router Link, shows the matched rule and pool, and waits to choose a representative until the operator selects a freshly verified future slot. That final transaction owns assignment, the routing decision, CRM writeback, calendar creation, conferencing, invitation, confirmation, reminder, and recipient management. The raw routing API remains available for ownership-only integrations but is no longer presented as a meeting scheduler.

Provider free/busy results may be cached briefly, but active booking ranges are subtracted from every response after that cache lookup. While a reschedule is waiting on its provider update, the booking reserves both the still-live original range and the requested replacement range. A terminal Handoff calendar failure can reset only that same booking and create job; it never reruns qualification, changes the representative or routing decision, advances assignment state, or duplicates CRM work. Before that reset, Hot Potato rechecks the assigned representative's exact original slot against fresh Google and Outlook availability; provider uncertainty or a newly busy calendar fails closed.

Upgrades keep the historical job-based slot index until older dashboard and pre-ledger public calendar jobs have been validated, converted into booking rows, and linked back to their original jobs. Pending and processing jobs become active reservations, completed jobs require matching provider event evidence, and malformed or overlapping active history aborts with a repair instruction before the old protection is removed. The booking row also stores explicit attendee-notification intent: public and Handoff bookings opt in, while legacy ownership-route bookings preserve whether an attendee was actually supplied and suppress invitations plus lifecycle email when they opted out. Provider reconciliation may confirm the ledger for an already-ended historical meeting, but only future meetings enqueue a newly recovered confirmation or reminder.

The Handoff tab stores a recovery capability in browser session storage so a refresh cannot strand a pending or failed assignment. Its serializer allowlists only the stable Smart Link ID, current slug, opaque token, selected time, and public meeting/rule/pool labels; attendee identity and qualification answers stay server-side. Recovery resolves the stable ID across a rename or unpublish, checks existing booking status before loading availability, and requires an explicit completed/new-handoff action before clearing an assigned session.

## 2026-08-31 — Attest in-flight bookings and reconcile uncertain provider writes

A qualification session acquires a hashed, 30-second booking-attempt lease with its exact UTC range before Google or Microsoft availability reads. Status returns that range as `attempting`, concurrent requests do no provider work, and the eventual booking transaction must present the owning attempt token. A stale attempt can be replaced, but its former owner can no longer commit. This makes a status `404` positive evidence that neither a booking nor a live attempt exists, so reload recovery can safely reopen availability.

Google event IDs and Microsoft transaction IDs are Hot Potato-owned idempotency evidence. A terminal calendar-create failure continues reserving the exact rep/time because a provider timeout can hide a successfully created event. Retry and close first query the assigned rep's provider for that exact transaction and time. Retry reuses a found event; otherwise it requires a fresh exact-slot check. Close moves to `cancel_pending`: a found event is deleted, while absence must be observed twice at least 30 seconds apart after a two-minute quiet period before release. Provider errors always stay locked, and a terminal deletion failure exposes the still-active meeting rather than claiming cleanup succeeded. Non-router scheduling creates enter this reconciliation automatically rather than exposing a terminal failure with no recovery path.

The same conservative rule applies to rescheduling. A terminal update error remains `reschedule_pending`, preserves both the old provider range and requested new range, and exposes a sanitized error on the management page. The only permitted retry is the exact stored new range and existing failed update job; a different change remains blocked until the original provider outcome is resolved.

Every worker claim now has a random database token separate from its retry count. Completion and failure are conditional on that exact token, so a reclaimed stale worker cannot apply a later booking transition. Google and Microsoft event operations also receive a real abort signal with a configurable two-minute default and four-minute maximum, always below the five-minute reclaim window; idempotent provider identities and the reconciliation path handle an unknown timeout outcome.

Published Smart Link slugs are permanent aliases to a stable link ID. An old URL redirects to the current slug while active; after unpublish it exposes only a generic recovery shell that can resolve an existing opaque booking token, never the retired questions or configuration. Accepted existing-form bridges keep their exact iframe alive when closed and expose a PII-free resume button instead of requiring the host form to resubmit identity.

## 2026-08-31 — Bootstrap production without restoring demo data

The default Compose path applies migrations and inserts only the configured organization when it does not exist. It never updates existing workspace data. Sample representatives, pools, rules, and links live behind an explicit demo profile because rerunning an upsert-style seed can silently reverse real operator changes.

Web and worker receive the same provider credentials needed for their respective read and write paths. The worker retries transient job-claim failures and drains its current operation before closing the database on shutdown, so a restart does not manufacture avoidable failed jobs.

## 2026-08-31 — Bind booking recovery to exact provider evidence

A booking's caller idempotency key, private management capability, provider transaction, and calendar-account owner are separate identities. New routed API bookings keep the caller value only in `source_external_id` and use a server-generated random UUID for management and provider idempotency. Historical arbitrary routed IDs remain usable for source deduplication but are never treated as bearer credentials.

The final availability quote records the exact representative, provider, external account, and selected conflict calendars. Provider responses count as proof only when their transaction marker, event identity, active state, exact time range, and HTTPS links agree with the request. A token refresh uses compare-and-swap guards so it cannot overwrite a concurrent reconnect, and a known account cannot be replaced while it owns future or unresolved bookings.

Legacy `NULL` account identity is not repaired from the current connection. Provider mutation remains blocked until an exact event lookup proves the account, transaction or event ID, and range. A timeout keeps the range reserved and enters conservative reconciliation; absence must be repeated after a quiet period before release. These rules apply equally to create, reschedule, cancel, Router, Handoff, and direct scheduling paths.

## 2026-08-31 — Resolve CRM ownership before routing

HubSpot is the system of record for current ownership when it is connected. Direct routing, public Smart Router qualification, and operator or form handoff discard a caller-provided owner, look up the contact by email, resolve its current active owner, and only then enter the router. A missing contact or unassigned owner is a valid unowned lead; a connected account with missing scope, bad configuration, timeout, or ambiguous provider data fails closed. The lookup is bounded to ten seconds and does not replace the asynchronous post-booking owner writeback.

This requires `crm.objects.contacts.read` in addition to the existing contact-write and owner-read scopes. Existing installations must reconnect once. The workspace readiness flow surfaces that requirement rather than letting a published route appear ready while ownership cannot be verified.

## 2026-08-31 — Let senders choose times, then revalidate

Gmail and Outlook now share one sender-controlled live-time contract: at most twelve localized choices, three diverse-day defaults when possible, and one to five distinct selections. The server rebuilds availability immediately before rendering the insert and rejects the whole selection if any time has filled. The client then refreshes the picker rather than inserting a partly stale suggestion.

Suggested times remain editable links, not reservations. Gmail and Outlook share the selection and rendering engine, show a positive post-insert state, prevent duplicate insertion while a request is active, and preserve a plain-text fallback for Outlook drafts that reject HTML.

## 2026-08-31 — Derive first-launch guidance from real readiness

The operator workspace starts with a four-stage launchpad for team, calendars, routing, and publishing. Its state is computed from the same representatives, provider compatibility, pools, rules, meeting types, Smart Link validation, and HubSpot connection scope used by the product. It presents one next action and blocks false completion when any active route targets an unbookable pool, uses an incompatible conferencing provider, or depends on a stale HubSpot connection.

Once one complete route is live, the launchpad turns into a compact operating surface for previewing or copying the link, opening Handoff, and using Gmail or Outlook. This keeps onboarding inside the product without introducing a second configuration model.

## 2026-08-31 — Reserve preparation and recovery time in the booking ledger

Preparation and recovery buffers belong to the meeting type but are snapshotted onto each booking. Changing a meeting type therefore affects future availability without silently moving the protected range of an existing meeting. Recipients see only bookable meeting times; Hot Potato does not create placeholder provider events or disclose internal buffer policy.

All scheduling surfaces share the same expanded conflict checks across selected Google and Outlook calendars. The database maintains concrete current and previous protected ranges with a trigger and applies exclusion constraints to both the representative and exact provider account. Application-level availability filtering improves the experience, while the booking ledger remains the final race-proof boundary for create and reschedule operations.

## 2026-08-31 — Keep reporting durable without retaining buyer PII

Smart Router reporting uses a minimal funnel-event ledger keyed by the opaque qualification-session ID, organization, link, outcome, and timestamps. It intentionally has no foreign key to the short-lived session, so privacy cleanup can delete or redact names, emails, answers, and request fingerprints without erasing aggregate conversion history. The existing routing decision and booking remain the sources for assignment share, calendar delivery, and meeting lifecycle outcomes.

The reporting contract keeps operational states separate. A qualified submission becomes **booked** when its durable booking transaction commits; Google or Outlook is **confirmed** only after the provider lifecycle succeeds. Cancelled, failed, and unresolved delivery states remain visible rather than being counted as provider success. Attendance is a human-entered outcome allowed only for past confirmed meetings, and operators may correct or clear it without rewriting the booking lifecycle.

## 2026-08-31 — Let senders choose the display timezone without surveillance

Gmail and Outlook use one validated timezone catalog for suggested times. The sender chooses the recipient-facing zone explicitly; Gmail submits the dropdown change through its official card action and Outlook refreshes an already-open picker. Uncommon valid IANA zones remain usable, invalid values fall back or fail safely, and the selected zone travels through the final render request so preview, insert, and copy cannot silently revert to the device timezone.

Timezone selection changes labels and day grouping, not the underlying UTC availability or booking rules. Hot Potato rebuilds live choices after a change and still revalidates every selected instant before insertion and again at booking. Gmail keeps `draftAccess: NONE`, Outlook does not read the draft, and neither client infers a timezone from recipients or enrichment data.

## 2026-08-31 — Replace the shared setup password with named operator sessions

The self-hosted environment remains the owner recovery authority, but bootstrap converts that credential into a named account, organization membership, and scrypt password hash. The reference Compose deployment passes the raw password only to bootstrap, and web runtime code never reads it. Browser login creates a random, hashed, revocable PostgreSQL session with a seven-day absolute expiry; the cookie is HTTP-only, same-site, and secure on HTTPS. Normal bootstrap preserves an in-app password change; an explicit one-run recovery flag resets the configured owner password and revokes that owner's sessions instead of making every browser resend one shared Basic credential indefinitely.

Roles are deliberately small: owners and admins configure routing, calendars, OAuth, and Outlook access keys; operators run Handoff, direct routing, and reporting. The high-impact Outlook key and OAuth-start routes repeat the admin check inside the handler. This real session boundary makes the old connector setup secret redundant, so provider installation now uses the signed-in admin plus the existing short-lived OAuth state and PKCE protections.

## 2026-08-31 — Keep team access self-hosted and link capabilities one-time

People & Access uses the same PostgreSQL authority as operator sessions rather than adding an identity vendor. Owners and admins can invite, reset, pause, and assign roles; only owners can manage owners, self-demotion or self-suspension is blocked, and the last active owner cannot be removed. Membership role or active-state changes revoke existing sessions so an old browser cannot retain broader access.

Invitation and password-reset credentials are random capabilities whose raw value is returned only once. PostgreSQL retains a SHA-256 hash with an explicit purpose, target, expiry, use, and revocation state. Consumption locks the link and changes membership or password atomically. Every member can change their own password and revoke other sessions, while owner recovery remains an explicit bootstrap operation for a locked-out self-hosted deployment.

## 2026-08-31 — Bind self-service calendars to operator identity, not browser state

A teammate may manage a representative calendar only when their active membership and account resolve to exactly one active representative with the same trimmed, case-insensitive email. Missing and duplicate matches fail closed. Owners and admins retain workspace-wide calendar authority, while the personal profile returns only the matched representative's redacted catalog and scheduling settings. Non-admin dashboard responses omit representative, pool, meeting-type, and form-bridge configuration that the operator workflow does not need.

OAuth initiation repeats the operator, origin, and representative authorization checks inside the handler. It stores a ten-minute PostgreSQL attempt bound to organization, operator, representative, provider, and destination by a SHA-256 hash of the random OAuth state. The callback requires the still-signed-in operator, matching state cookie, PKCE verifier, and a one-time durable attempt; it derives the representative only from that locked record. Provider denial consumes the attempt, replay returns no record, and access is rechecked at both creation and consumption. Expired and old consumed attempts join the existing hourly cleanup.

The personal UI keeps conflict reads and booking writes conceptually separate: selected calendars from both providers block time, while one provider default receives each meeting. Reconnection preserves the public booking link. Desktop navigation exposes **My calendar** to every member, and the phone header keeps it directly reachable after the full sidebar collapses.

## 2026-08-31 — Let representatives own their default availability

A matched teammate can edit the timezone and weekly hours for their exact representative from **My calendar**; owners and admins retain the same editor for every rep. The shared contract accepts up to four periods per day, rejects overlap and malformed IANA timezones, sorts ranges before storage, and allows an explicitly all-unavailable week with a visible warning. The same weekly schedule already feeds personal and pool links, Smart Router Links, Handoff, Gmail, and Outlook, so one save changes every future availability read without creating a second scheduling model.

Friendly authorization happens before body parsing, but the database write repeats organization, active account, active membership, role, exact normalized-email match, and single-active-rep checks inside one `UPDATE`. A role change, account pause, cross-workspace ID, or newly ambiguous rep mapping therefore fails without mutation. A meeting must also fit inside one continuous daily period; matching only its start and end may not bridge an unavailable break.

## 2026-08-31 — Model date exceptions as overrides, not another schedule engine

Each representative may store up to 120 `YYYY-MM-DD` overrides in their own timezone. A present key replaces the weekly hours for that local date: an empty array means unavailable all day, while one to four non-overlapping ranges opens custom hours. Real-date validation rejects impossible calendar values, normalization sorts dates and periods, and an omitted override field preserves existing data for older API clients.

The override travels with the representative through routing, personal and pool links, Smart Router Links, Handoff, Gmail, Outlook, and managed rescheduling. The shared pure scheduling predicate applies it before weekly hours, so every surface has identical semantics. Availability cache keys include timezone, weekly hours, and overrides; a save therefore cannot reuse a slot snapshot from the old schedule. PostgreSQL stores the bounded object with a safe empty default, and the same atomic identity-scoped update writes weekly and date-specific hours together.

## 2026-08-31 — Reuse named weeks without adding a second availability engine

An organization may define named weekly schedules and assign one to many representatives. The template contains local wall-clock ranges but no timezone; every rep retains their own timezone and date overrides. Owners and admins create, edit, or remove templates, while a matched representative may choose an existing template or detach to custom hours. Template names are case-insensitively unique inside one organization, and the database foreign key prevents cross-workspace assignment.

The rep's existing `availability` remains the one effective weekly value used by routing, personal and pool links, Smart Router Links, Handoff, Gmail, Outlook, and rescheduling. Assigning a template copies its current week under a shared row lock; editing a template updates every assigned rep in the same transaction. This avoids joins or divergent logic in hot scheduling paths while keeping the association visible. Deleting a template first detaches assigned reps and preserves their last copied hours, so removing organization metadata never silently closes booking links. Personal date overrides remain untouched throughout assignment, propagation, and deletion.

## 2026-08-31 — Make catch-all routing an explicit final invariant

An organization may save one condition-free routing rule as its catch-all. Conditional rules keep their ordinary numeric priority, while the shared pure router always evaluates the catch-all after every conditional rule regardless of its stored priority. Preview, direct routing, Smart Router Links, Handoff, session revalidation, and reporting therefore agree on the same final path. The stored priority remains unique audit metadata instead of becoming a hidden interception mechanism.

The settings API requires an explicit `catchAll` intent before accepting an empty condition set, rejects conditions on that mode, and PostgreSQL permits only one catch-all per organization. Routing Studio creates it through a separate action, labels it **LAST**, explains the behavior in the editor and trace, and disables duplicate creation. A catch-all still uses an ordinary pool and meeting destination, so Google/Outlook availability checks, weighted selection, booking locks, CRM writeback, and provider reconciliation stay on the existing path. Pausing the rule restores the configured no-match message without deleting routing history.

## 2026-08-31 — Keep additional guests inside the booking lifecycle

A primary booker may add up to five external guests from a scheduling link, Smart Router or embedded flow, or operator Handoff. Addresses are lowercased, deduplicated, and stored on the durable booking row before the calendar job is queued. The primary booker remains the sole owner of Hot Potato lifecycle email and the private management capability; additional guests receive provider invitations and updates, and their availability is explicitly not checked. This is multiple-attendee booking, not co-host scheduling.

Google Calendar and Outlook receive the same ordered attendee contract. Ordinary events include every guest at creation. Native Google Meet and Microsoft Teams events still withhold all attendees until the join URL is verified, then add and verify the complete list. Idempotent retries repair missing guests without creating a second event, time-only reschedules preserve the provider attendee list, and terminal conference or attendee-finalization failures clean up the owned event instead of confirming a partial meeting.

## 2026-08-31 — Authenticate Outlook with a Hot Potato scope, not mailbox access

The Outlook task pane uses Microsoft Entra nested app authentication to request one delegated `access_as_user` permission exposed by Hot Potato itself. The API accepts only a signed v2 access token with the exact audience, tenant-derived issuer, authorized client, scope, and expiry. Authorization uses the stable tenant-and-subject identity, not the mutable username/email claim. A first connection must present both that token and one active rep-scoped fallback key; PostgreSQL binds the principal, key, organization, and representative atomically, rejects reuse across a different principal, and requires that key to remain active. NAA first tries silent acquisition, then a popup, then an Office Dialog flow for clients that cannot complete the nested flow.

The Outlook XML manifest remains at `ReadWriteItem`; identity adds no Graph or mailbox-reading permission. Calendar OAuth remains a separate connection. Existing rep-scoped pairing keys remain a revocable fallback for unsupported clients and recovery, not the primary identity path. One stable Entra application ID is shared by the NAA runtime configuration and rendered manifest. The deployment origin determines the custom scope URI and redirect URIs, while v2 access-token audience validation uses the API client-ID GUID.

## 2026-08-31 — Remember successful sender choices, not draft context

Gmail and Outlook store each representative's most recent valid booking-link asset and live-time meeting as two purpose-specific preferences. Outlook also records which format succeeded last so the task pane reopens in the same mode; a Smart Router Link always forces link mode. The catalog returns a preference only while the asset remains active and available to that representative.

The preference ledger contains organization, representative, purpose, and asset IDs only. It never receives draft, recipient, subject, attachment, or mailbox data. Gmail writes after preparing a valid draft-update response, while Outlook writes after a successful insert or copy. Both are deliberately best-effort, so a storage failure cannot block or duplicate insertion.

## 2026-08-31 — Enforce representative capacity in local calendar periods

Each representative may set an optional daily maximum and Monday–Sunday weekly maximum. Both periods use that representative's IANA timezone, and the same active booking ledger feeds public and pooled links, Smart Router and embedded flows, Handoff, Gmail, Outlook, and recipient rescheduling. Full periods are removed after live provider conflict checks, including when provider slots came from the short cache.

The database remains authoritative. Every active booking insert or scheduling-range change takes the representative lock and runs a capacity trigger, while pool booking transactions recheck capacity under that lock and may try another candidate. Pending, confirmed, failed, reschedule-pending, and cancel-pending rows count because each can still own provider state; cancelled rows immediately stop counting. One rescheduling booking is deduplicated inside a day or week, and its existing period supplies capacity credit so an operator can move a grandfathered meeting without increasing load.

Older working-hours clients may omit the new fields without clearing stored limits. Explicit `null` means unlimited, while bounded integers keep the UI and database constraints aligned.

## 2026-08-31 — Reserve every required participant for collective scheduling

A meeting type may add up to ten active co-hosts. A required co-host contributes working hours, date overrides, selected Google and Outlook conflict calendars, existing reservations, and local meeting capacity to the exact slot intersection. An optional co-host receives the provider invitation without reducing availability. Saving fails closed when a required co-host lacks a ready conflict calendar.

Bookings snapshot the configured team, and one participant-reservation ledger covers the routed organizer plus every required co-host. A shared meeting-type lock freezes the configuration between quote validation and the snapshot; sorted participant locks, range exclusion, and the shared capacity trigger make cross-role double booking impossible even when concurrent requests choose the same person through different meeting types. Cancellation releases every reservation; managed rescheduling keeps the booking snapshot rather than adopting later meeting-type edits.

The organizer's selected Google or Outlook account owns the provider event and conference link. Every active co-host is a deduplicated attendee, so a Google organizer and Outlook co-host work through the same event lifecycle as a single-host meeting. Public payloads expose only team names and whether required calendars are checked; account IDs, selected calendar IDs, emails, and availability quotes remain server-side.

## 2026-08-31 — Continue conversion only after a durable booking

A Smart Router Link may save one absolute success URL and a 1–30 second confirmation window. HTTPS is required outside loopback development; the API and repository reject credentials and fragments, while PostgreSQL preserves the protocol, character, length, and delay bounds. The buyer sees the confirmed meeting and an immediate continuation link before navigation. Direct links navigate themselves, while embedded flows ask the origin-checked host loader to navigate the top-level page.

The iframe emits `booked` only after the booking ledger is confirmed, with the saved redirect policy and no buyer data. The loader validates the exact message shape, dispatches a cancelable `hotpotato:booked` event, and schedules navigation only when the host accepts it. Closing a bridge cancels a pending redirect and emits a PII-free `closed` result; successful empty availability and no-match qualification emit `no_slots` and `disqualified`. A Smart Link edit still invalidates pinned form bridges until the operator reviews and saves them again.

## 2026-08-31 — Treat pooled co-host roles as real assignments

A meeting type may add up to five unique co-host pools in addition to fixed co-hosts. A required pool contributes a disjunction—at least one eligible member must be free—while an optional pool ignores availability but still assigns one active person. Configuration rejects the organizer pool, duplicate pools, or a set of roles that cannot resolve to distinct active people; required candidates also need ready Google or Outlook conflict calendars.

Availability carries every currently valid candidate for each required pool instead of preselecting a person. At booking, Hot Potato takes every involved pool lock and participant lock in stable order, reapplies reservations and local capacity, and chooses a distinct weighted-fair combination. Backtracking avoids a greedy dead end when one person belongs to multiple pools. Each selected role advances its own assignment state.

The selected people, required/optional policy, and source-pool names are snapshotted onto the booking. Required selections receive durable participant reservations; optional selections are invitation-only. Retries can revalidate the originally selected member against a fresh pooled quote, while managed rescheduling keeps the booked team rather than rerouting co-hosts after the buyer has already met them.

## 2026-08-31 — Enforce buyer guardrails in the booking transaction

A meeting type may cap active or upcoming bookings per normalized invitee email or exact email domain. Direct scheduling, Smart Router Links, embeds, and Handoff use the same rule. Pending, confirmed, provider-uncertain, reschedule-pending, cancel-pending, and failed reservations count until their meeting ends or the booking is cancelled; a caller's exact idempotent retry is excluded. Email and domain identities each take a deterministic PostgreSQL advisory lock before counting, so concurrent requests cannot both pass the same remaining allowance.

Reschedule and cancellation deadlines are independent, may be unlimited, and are measured from the booked start time. New operator-created meeting types default to closing changes at the meeting start; upgraded meeting types preserve their prior unlimited behavior until edited. Each booking snapshots both deadlines. The recipient page stops loading slots and disables closed actions, while the locked lifecycle mutation repeats the check against database time. An exact retry or safe close of an already-uncertain reschedule remains available so a provider timeout cannot strand two reserved ranges.

## 2026-08-31 — Snapshot secondary CRM roles after team assignment

A rotating co-host pool may map its selected person into one unique HubSpot contact user property. The operator supplies the lowercase internal property name; `hubspot_owner_id` remains reserved for the routed organizer, and duplicate role fields are rejected in the API, repository, and database. The property name is configuration only and never enters a public schedule payload.

The booking transaction first chooses and snapshots every pooled co-host, then carries configured property-and-email pairs on the durable calendar job when HubSpot is connected. Only confirmed calendar creation or reconciliation enqueues the unique `crm.roles.writeback` job. The worker resolves all selected emails against one paginated owner directory read and patches every role property in one contact update. This job is separate from primary-owner writeback, and HubSpot retries happen after provider confirmation, so they cannot delay, roll back, or duplicate a Google or Outlook meeting or assign secondary owners for a meeting that never existed.
