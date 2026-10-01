# Hot Potato Outlook add-in

This directory contains an add-in-only XML manifest for a compose-mode Outlook task pane hosted by Hot Potato at `/email/outlook`. It intentionally requests only `ReadWriteItem`: it does not request Microsoft Graph scopes, `ReadWriteMailbox`, background activation, or access to other messages.

## What this slice is

The primary identity path is Microsoft Entra nested app authentication (NAA). The task pane requests Hot Potato's own `access_as_user` delegated permission, not a Microsoft Graph or mailbox scope. It tries silent token acquisition, then an NAA popup, then an Office Dialog sign-in fallback. The server validates the access token and resolves its stable tenant-and-subject identity through a durable Hot Potato representative binding. A first connection proves both sides with one active rep-scoped fallback key; the mutable username/email claim is never the authorization key.

Rep-scoped pairing keys remain a recovery path for unsupported clients and the one-time Microsoft binding proof. The server stores only a key hash, while the task pane keeps the raw key only in that WebView's session storage. It deliberately never uses Office roaming settings. Treat a fallback key like a password: collect it inside the task pane over HTTPS, never place it in the manifest or a URL, and never log it. A copied key works anywhere it is pasted until an admin revokes it; **Disconnect** removes only the current session copy. A key binds at most one Microsoft principal, and revoking it disables both direct-key access and the linked principal. The organization and representative remain fixed server-side.

After a successful insert or copy, the pane stores only the selected shareable asset and whether the rep used a booking link or live times. It reopens that active choice next time, keeps separate recent link and meeting selections, and automatically treats Smart Router Links as link-only. Preference failures do not fail or repeat an insertion.

## Configure Microsoft Entra NAA

Create an Entra app registration that supports both organizational accounts and personal Microsoft accounts. Use one stable application (client) GUID for `OUTLOOK_NAA_CLIENT_ID` and the manifest renderer's `--app-id`, and configure v2 access tokens.

For a deployment at `https://schedule.example.com` with client ID `11111111-2222-4333-8444-555555555555`:

1. Expose the API application ID URI `api://schedule.example.com/11111111-2222-4333-8444-555555555555`.
2. Add one delegated scope named `access_as_user` and allow users and admins to consent.
3. Add these **Single-page application** redirect URIs:
   - `brk-multihub://schedule.example.com`
   - `https://schedule.example.com/email/outlook/auth`
   - `https://schedule.example.com/email/outlook/auth-dialog`
4. Set `APP_URL=https://schedule.example.com` and `OUTLOOK_NAA_CLIENT_ID=11111111-2222-4333-8444-555555555555` in the web runtime.

Hot Potato derives the exact scope URI and redirect set from those values. It validates a v2 access token's `aud` as the API client-ID GUID, not the `api://…` scope URI. Do not add Microsoft Graph permissions, mailbox-wide permissions, a client secret, or ID-token forwarding for task-pane identity. Calendar OAuth under `integrations/microsoft` is separate and does not authorize the compose pane.

## Render the manifest

Requirements: Node.js 20 or newer and a publicly reachable HTTPS Hot Potato deployment. The deployment must serve the task pane and icons at the exact paths in the manifest.

From `integrations/outlook`:

```sh
node scripts/render-manifest.mjs \
  --origin https://schedule.example.com \
  --app-id 11111111-2222-4333-8444-555555555555 \
  --output manifest.generated.xml
xmllint --noout manifest.generated.xml
```

Generate and retain one stable, unique GUID for the add-in. Use `--force` only when intentionally replacing an existing rendered file. The helper rejects HTTP (including HTTP localhost), origins containing paths or credentials, unknown or unexpanded variables, cross-origin resource URLs, broader mailbox/Graph permissions, and output paths that overwrite the template.

The task pane uses its own Pages Router document so Microsoft's hosted Office.js is a blocking `<head>` script before the framework bundles, without loading Office.js on the rest of Hot Potato. Before sideloading, verify these URLs without authentication:

- `https://schedule.example.com/email/outlook` returns the task pane and loads Office.js from Microsoft's hosted CDN.
- `https://schedule.example.com/email/outlook/auth` and `/email/outlook/auth-dialog` return frameable, uncached NAA redirect pages.
- `https://schedule.example.com/email/outlook/assets/icon-{16,32,64,80,128}.png` returns the matching PNG from `assets/` with the correct MIME type.
- The response permits framing by Outlook. Do not send `X-Frame-Options: DENY` or a CSP `frame-ancestors` rule that excludes Microsoft 365 Outlook hosts.

For Microsoft schema validation, run `npx office-addin-manifest validate manifest.generated.xml` in a disposable tool environment or CI. `xmllint` proves the file is well-formed XML; Microsoft's validator is the authoritative schema check.

## Sideload exactly

1. Deploy the HTTPS task pane and icon files, then render and validate `manifest.generated.xml`.
2. Sign in to the mailbox used for testing and open [https://aka.ms/olksideload](https://aka.ms/olksideload) in a browser. Wait for the **Add-Ins for Outlook** dialog.
3. Select **My add-ins**. Under **Custom Addins**, select **Add a custom add-in** > **Add from File**.
4. Choose `manifest.generated.xml` and accept the installation prompts. **Add from URL is no longer available.**
5. Start a new message, reply, or forward. In Outlook on the web and new Outlook for Windows, open **Apps** and choose **Hot Potato**; in classic Windows or Mac, find **Schedule with Hot Potato** on the compose ribbon or add-ins menu.
6. Open the pane and choose **Continue with Microsoft**. On the first connection, paste one fallback key for the intended representative to create the durable Microsoft binding. Reopen the pane and confirm Microsoft signs in without the key, then insert both a booking link and suggested times into test drafts. Revoke the bootstrap key and confirm both Microsoft and direct-key access stop. Reinstall the manifest after any command or resource change. Classic Outlook for Windows can cache a manual sideload for up to 24 hours.

Remove it from the same dialog: **My add-ins** > **Custom Addins** > Hot Potato **...** > **Remove**.

## Insertion contract

The task pane must call `Office.context.mailbox.item.body.getTypeAsync` immediately before insertion, then call `setSelectedDataAsync` with matching coercion:

- For an HTML body, insert a small sanitized fragment with an HTTPS `<a>` and simple structural tags. Do not use scripts, SVG, event attributes, remote images, or inline CSS. If Outlook rejects HTML sanitization, offer a plain-text retry instead of silently claiming success.
- For a plain-text body, insert a readable URL or time list with line breaks and no HTML markup.
- Outlook replaces the current selection. With no selection, it inserts at the cursor; if the editor has never received focus, some clients place content at the top. Tell the user what will happen and surface the Office.js callback error.

Suggested times are a snapshot, not a hold. Include timezone information, link every option back to the live booking flow, and have the scheduling page recheck availability before confirmation. Keep inserted content well below the Office body API's size limit.

The add-in must not read or send recipients, subject, existing body text, or attachments to Hot Potato. `ReadWriteItem` is used only to insert the user-selected scheduling content into the current draft.

## Client boundary

These are expected client boundaries from the manifest and API requirements, not a record of completed real-client verification. Qualify each intended client and mailbox combination with the release test matrix before distributing the add-in.

| Client/account                                                                  | Expected status                                                                                                                                           |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outlook on the web, Microsoft 365 or Outlook.com mailbox                        | Supported for desktop compose; test both HTML and plain text.                                                                                             |
| New Outlook for Windows, Microsoft 365 or Outlook.com mailbox                   | Supported for desktop compose; command is generally under **Apps**.                                                                                       |
| Classic Outlook for Windows with a supported Exchange/Microsoft 365 mailbox     | Supported; manual sideload visibility can be delayed by caching.                                                                                          |
| Outlook for Mac 16.38 or newer, Microsoft 365 or Outlook.com mailbox            | Supported by this add-in-only XML manifest; use the Outlook sideload dialog.                                                                              |
| Outlook iOS or Android                                                          | Not supported for this compose command/task-pane slice. Outlook mobile add-in activation is primarily message-read; mobile cannot be sideloaded directly. |
| Gmail, Yahoo, or other non-Microsoft mailbox in Outlook web, Windows, or mobile | Unsupported by Outlook add-ins.                                                                                                                           |
| Non-Microsoft mailbox on Mac using IMAP CloudCache                              | Microsoft documents general add-in support, but this compose slice is unqualified; treat it as unsupported until tested. IMAP Direct is unsupported.      |
| Protected/IRM messages, delivery reports, attached `.msg`/`.eml`, offline mode  | Do not promise support; detect Office.js errors and preserve the draft.                                                                                   |

The `ItemEdit` declaration in `FormSettings` is the valid legacy desktop-form fallback required by the add-in-only schema. Clients that understand add-in commands use `VersionOverrides` and the `MessageComposeCommandSurface`; the legacy form is not a substitute for qualifying the modern command path.

## Release test matrix

Run every release candidate against at least the following. Record client version, mailbox type, body type, operation, and result.

| Area          | Minimum cases                                                                                                                                  | Pass condition                                                                                                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest      | Fresh install, upgrade with same GUID and higher version, uninstall/reinstall                                                                  | XML and Microsoft validation pass; one compose command appears; no read-mode command appears.                                                                                                                           |
| Compose modes | New message, reply, reply-all, forward; inline and pop-out where available                                                                     | Pane opens at `/email/outlook`; insertion changes only the active draft.                                                                                                                                                |
| Body formats  | HTML and plain text, selected text and cursor-only, editor never focused                                                                       | Correct coercion and placement; HTML rejection offers plain text; errors are visible.                                                                                                                                   |
| Content       | Booking link, Smart Router Link, one time, multiple times, recent-choice reopen, long labels, non-ASCII names                                  | Links are HTTPS, escaped, readable, remain below API limits, and Smart Router Links never open in live-time mode.                                                                                                       |
| Timezones     | User/recipient in same zone, different zones, DST boundary                                                                                     | Displayed zone is explicit and live booking revalidates every slot.                                                                                                                                                     |
| Identity      | NAA silent, popup, dialog, personal/work account, first binding, principal/key reuse conflicts, valid/revoked fallback key, server unavailable | Each bound principal resolves to exactly one active rep; unsupported and failure paths are explicit; revoked, cross-scope, conflicting, and unavailable cases fail closed without exposing other reps or organizations. |
| Privacy       | Draft with sensitive body, recipients, attachments                                                                                             | Network inspection shows none of those fields leave Outlook.                                                                                                                                                            |
| Clients       | Web, new Windows, classic Windows, Mac at supported versions                                                                                   | Command, task pane, pairing, insertion, error state, and uninstall all behave as documented.                                                                                                                            |
| Accessibility | Keyboard-only, 200% zoom, high contrast/screen reader                                                                                          | Every action is named, reachable, visible, and reports success/failure without color alone.                                                                                                                             |

## Microsoft references

- [Build a message compose Outlook add-in](https://learn.microsoft.com/office/dev/add-ins/tutorials/outlook-tutorial)
- [Sideload Outlook add-ins for testing](https://learn.microsoft.com/office/dev/add-ins/outlook/sideload-outlook-add-ins-for-testing)
- [Outlook add-in manifests and permissions](https://learn.microsoft.com/office/dev/add-ins/outlook/manifests)
- [Insert data in the body when composing](https://learn.microsoft.com/office/dev/add-ins/outlook/insert-data-in-the-body)
- [Authenticate with nested app authentication](https://learn.microsoft.com/office/dev/add-ins/develop/enable-nested-app-authentication-in-your-add-in)
- [NAA identity-to-API sample](https://learn.microsoft.com/samples/officedev/office-add-in-samples/outlook-add-in-sso-naa-identity/)
- [Validate Microsoft identity-platform access tokens](https://learn.microsoft.com/entra/identity-platform/access-tokens)
- [Outlook add-in support by client and account](https://learn.microsoft.com/office/dev/add-ins/outlook/outlook-add-ins-overview)
