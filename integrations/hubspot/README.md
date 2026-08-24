# HubSpot app

This directory contains the source-controlled HubSpot developer-platform app definition for Hot Potato.

The app uses OAuth and requests only the permissions required to assign contact ownership:

- `crm.objects.contacts.write`
- `crm.objects.owners.read`

Its local OAuth callback is `http://localhost:3000/api/connections/hubspot/callback`.

Validate or upload from this directory with the HubSpot CLI:

```bash
hs project validate
hs project upload
```
