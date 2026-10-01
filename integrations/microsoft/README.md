# Microsoft Entra app

Hot Potato uses a multitenant confidential web application for Microsoft 365 work/school accounts and personal Outlook.com accounts. Organization-level connections request delegated `Calendars.ReadBasic` for multi-rep free/busy. Rep-level connections request delegated `Calendars.ReadWrite`; each rep authorizes only their own mailbox so Hot Potato can read that calendar's availability and write confirmed bookings directly to it.

Create the app from the repository root:

```bash
az ad app create \
  --display-name "Hot Potato" \
  --sign-in-audience AzureADandPersonalMicrosoftAccount \
  --web-redirect-uris \
    http://localhost:3000/api/connections/microsoft/callback \
    http://localhost:3000/api/rep-connections/microsoft/callback \
  --required-resource-accesses @integrations/microsoft/required-resource-access.json
```

Personal Microsoft accounts require access-token version 2. Set `api.requestedAccessTokenVersion` to `2` in the app manifest before authorizing an Outlook.com account.

Create a client credential, then place the application client ID and credential value in the ignored local `.env` as `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET`. Never commit the credential.

For a hosted instance, add the equivalent exact HTTPS callback URLs to the Entra application before authorizing Microsoft 365. `Calendars.ReadWrite` is delegated, so it does not grant Hot Potato tenant-wide mailbox access and normally does not require administrator consent.
