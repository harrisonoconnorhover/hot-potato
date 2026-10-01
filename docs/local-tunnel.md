# Temporary remote testing

Hot Potato can be shared from a developer machine without deploying the app. This is intended only for short setup and UI testing.

## One-time setup

1. Install Cloudflare's tunnel client: `brew install cloudflared`.
2. Set `HOT_POTATO_ADMIN_USER`, optional `HOT_POTATO_ADMIN_NAME`, a 12+ character `HOT_POTATO_ADMIN_PASSWORD`, and `TRUSTED_PROXY_CLIENT_IP_HEADER=cf-connecting-ip` in the ignored `.env` file. Only trust that header while direct origin access remains loopback-only.
3. Start Hot Potato: `docker compose up -d --build`.

## Start the link

Run this in a terminal and leave it open:

```bash
cloudflared tunnel --url http://localhost:3000
```

Cloudflare prints a temporary `https://...trycloudflare.com` address. Opening the root workspace redirects to Hot Potato's named operator login. The exact tunnel origin is accepted for login/logout and produces a secure browser cookie even while `APP_URL` remains localhost. The password is checked against its scrypt hash in PostgreSQL and is not passed to the web process after bootstrap.

The address changes whenever the tunnel restarts. Stop it with `Control-C`. The link stops working immediately; Hot Potato remains available at `http://localhost:3000`.

## Exposure boundary

The revocable operator session protects the workspace, routing API, booking API, connection management, and rep-connection setup. Owners and admins can change settings; operators can run handoffs, route leads, and view reporting. Public scheduling pages and their booking API remain public by design so a recipient can use a shared scheduling link. Signed OAuth callbacks and `/api/health` also remain reachable.

Do not treat this as production hosting. A stable hostname still requires a real deployment or a domain-backed tunnel. Production also needs provider review, durable backups, TLS at the public edge, and the existing public scheduling rate limits configured for its trusted proxy.

Because the temporary hostname changes, keep `APP_URL=http://localhost:3000` for same-Mac connector testing. Testing OAuth from another device requires registering the current HTTPS callback URLs with each provider and updating `APP_URL` for that tunnel session.
