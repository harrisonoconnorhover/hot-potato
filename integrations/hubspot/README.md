# HubSpot app

This directory contains the source-controlled HubSpot developer-platform app template for Hot Potato. Before uploading a deployment, replace `support@example.com` with a support address you control and review the documentation/support URLs, OAuth redirect URLs, and distribution settings for that deployment. The checked-in marketplace setting does not imply a published or approved marketplace listing.

The app uses OAuth and requests only the permissions required to preserve existing contact ownership and assign the routed owner:

- `crm.objects.contacts.read`
- `crm.objects.contacts.write`
- `crm.objects.owners.read`

Its local OAuth callback is `http://localhost:3000/api/connections/hubspot/callback`.

Validate or upload from this directory with the HubSpot CLI:

```bash
hs project validate
hs project upload
```
