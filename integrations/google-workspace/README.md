# Gmail compose add-on

This package defines Hot Potato's first-party Google Workspace HTTP add-on: one Gmail compose action, one public HTTPS endpoint, and no draft-reading permission. It is designed to let a signed-in Hot Potato user choose scheduling options and insert an editable booking link or suggested times into the draft.

The card remembers each representative's last booking-link asset and live-time meeting for which the server emitted a valid draft-insertion response, then preselects those active choices the next time it opens. Preference persistence is convenience-only: a failed write never blocks Gmail's draft insertion action.

The checked-in manifest is a template. Replace both `https://hot-potato.example` URLs in `deployment.example.json` before creating a deployment. Keep every current and future `runFunction` on the exact same endpoint so the system ID token has one stable audience:

```text
https://YOUR_PUBLIC_ORIGIN/api/integrations/google-workspace-addon
```

The endpoint must accept `POST` JSON, verify the request before doing any account lookup, and return a valid Google Workspace card or draft-update response. Use `createGoogleWorkspaceAddonVerifier` from `@hot-potato/integrations` with these values:

- `endpointAudience`: the exact HTTPS URL above, byte-for-byte identical to `runFunction`.
- `oauthClientId`: `oauthClientId` from `gcloud workspace-add-ons get-authorization`.
- `systemServiceAccountEmail`: `serviceAccountEmail` from the same command.

The verifier checks Google signatures and expiry through `google-auth-library`, the exact audience, a Google issuer, the exact add-on service-account email, and verified email claims. After authenticating Google's system token, it validates `authorizationEventObject.authorizedScopes`; a partial grant returns Google's `requesting_google_scopes: { all_scopes: true }` response before requiring user identity. On Google's automatic replay, it separately verifies `authorizationEventObject.userIdToken` for the add-on OAuth client ID and returns a lower-case, trimmed user email. Its result deliberately omits the bearer token, user ID token, user OAuth token, system ID token, and Gmail access token. Do not log the raw request body or `Authorization` header.

## Permissions

| Scope or setting                      | Why it is present                                                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `gmail.addons.execute`                | Lets Gmail invoke and render the add-on. It is the narrow add-on execution scope, not general mailbox access.                                |
| `gmail.addons.current.action.compose` | Required for Gmail compose triggers and for an explicit user action to update the open draft.                                                |
| `userinfo.email`                      | Supplies the signed-in user's ID token so Hot Potato can map the request to the correct account.                                             |
| `script.locale`                       | Supplies locale and timezone for localized cards and suggested times; paired with `useLocaleFromApp: true`.                                  |
| `draftAccess: NONE`                   | Keeps draft body, subject, and recipients out of the compose-trigger event. No current-message metadata or broad Gmail scopes are requested. |
| `SYSTEM_ID_TOKEN`                     | Makes Google authenticate each HTTP invocation as this add-on's project-specific service account.                                            |
| `granularOauthPermissionSupport`      | Opts into Google's required partial-consent flow; the endpoint requests all four genuinely required scopes when any are missing.             |

Google documents the [HTTP runtime and request validation](https://developers.google.com/workspace/add-ons/guides/alternate-runtimes), [Gmail compose actions](https://developers.google.com/workspace/add-ons/gmail/extending-compose-ui), [deployment manifest](https://developers.google.com/workspace/add-ons/reference/rest/v1/projects.deployments), and [locale access](https://developers.google.com/workspace/add-ons/guides/access-user-locale-timezone).

## Create and install a test deployment

Prerequisites: a Google Cloud project with billing enabled where required, the current Google Cloud CLI, a deployed public HTTPS endpoint, and the Google Workspace Marketplace SDK enabled for that project. Configure the OAuth consent screen for the intended test users first.

From the repository root, run these commands with your project ID:

```bash
gcloud auth login
gcloud config set project YOUR_GOOGLE_CLOUD_PROJECT_ID
gcloud services enable gsuiteaddons.googleapis.com
gcloud workspace-add-ons get-authorization
cp integrations/google-workspace/deployment.example.json integrations/google-workspace/deployment.json
```

Edit the local `deployment.json` so both example URLs use the real origin, and don't commit that environment-specific copy. Configure the server verifier with the exact endpoint, `oauthClientId`, and `serviceAccountEmail` printed above, then deploy the server. Validate the JSON and create the unpublished deployment:

```bash
node -e "JSON.parse(require('node:fs').readFileSync('integrations/google-workspace/deployment.json', 'utf8'))"
gcloud workspace-add-ons deployments create hot-potato-gmail --deployment-file=integrations/google-workspace/deployment.json
gcloud workspace-add-ons deployments install hot-potato-gmail
gcloud workspace-add-ons deployments install-status hot-potato-gmail
```

For a manifest update, keep the deployment ID and replace it in place:

```bash
gcloud workspace-add-ons deployments replace hot-potato-gmail --deployment-file=integrations/google-workspace/deployment.json
```

Then open or reload Gmail using the account that installed the deployment, authorize the four scopes, start a new draft, and choose the Hot Potato icon. On Gmail web the icon is in the row at the bottom of the compose window; on Gmail mobile, compose add-ons are in the top-right menu. Uninstall the test deployment with:

```bash
gcloud workspace-add-ons deployments uninstall hot-potato-gmail
```

These commands follow Google's current [Node.js HTTP add-on quickstart](https://developers.google.com/workspace/add-ons/quickstart/alternate-runtimes) and [gcloud deployment reference](https://docs.cloud.google.com/sdk/gcloud/reference/workspace-add-ons/deployments).

## Test matrix

This is a qualification plan, not a record of completed testing on real Gmail accounts or devices. Mocked verifier and response tests establish the local contracts only.

Use a real Google Workspace account and, separately, a consumer Gmail account when the OAuth audience permits both.

| Client                             | New draft | Reply    | What to verify                                                                                                                                                                                                                                                                 |
| ---------------------------------- | --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Gmail web, current Chrome          | Required  | Required | Icon appears at the bottom of compose; card loads with the rep's recent active choices preselected; 1–5 of up to 12 fresh times can be selected; stale choices refresh without insertion; insertion happens once before the card changes to confirmation; HTML stays editable. |
| Gmail for iOS, current release     | Required  | Required | Action appears in the compose top-right menu; card fits the mobile sheet; tap targets and loading/error states work; inserted content remains editable after returning to the draft.                                                                                           |
| Gmail for Android, current release | Required  | Required | Same mobile checks, including back-navigation, rotation, and a slow or interrupted network retry.                                                                                                                                                                              |
| Every client                       | Required  | Required | Authorization denial is understandable; expired or wrong-audience tokens fail closed; no draft/recipient/token data appears in application logs; a signed-in Google identity maps only to its own Hot Potato account.                                                          |

Also run the local, network-free verifier tests before deploying:

```bash
npm run test --workspace @hot-potato/integrations
npm run typecheck --workspace @hot-potato/integrations
```

## Marketplace readiness

An unpublished `gcloud ... deployments install` is only a development install; it is not public Marketplace readiness. Before a public launch, use an External production OAuth consent screen, make the scope lists match in the consent screen, Marketplace SDK, and manifest, complete OAuth verification when Google requires it, and publish working privacy-policy, terms, support, and data-deletion pages. Prepare accurate listing assets and screenshots, test both desktop and mobile on a separate domain/account, document any paid or account prerequisites, and submit the listing for Google review. Public apps must be stable and complete; Google's review explicitly checks OAuth setup, least-privilege scopes, functionality, listing accuracy, and user experience.

See Google's [OAuth configuration](https://developers.google.com/workspace/marketplace/configure-oauth-consent-screen), [store listing requirements](https://developers.google.com/workspace/marketplace/create-listing), and [app review criteria](https://developers.google.com/workspace/marketplace/about-app-review). Visibility should be chosen carefully because Google says the saved public/private visibility choice can't later be changed.
