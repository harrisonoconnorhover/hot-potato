# Contributing

Thanks for helping make inbound routing less painful.

## Development

1. Install Node.js 22+ and Docker.
2. Run `npm install`.
3. Run `docker compose up -d postgres`.
4. Run `npm run db:setup`.
5. Run `npm run dev`; start `npm run dev:worker` separately when testing jobs.

Before opening a pull request, run:

```bash
npm run format:check
npm run typecheck
npm test
npm run build
npm run test:integration
```

Keep changes focused. Routing behavior belongs in the pure router package with a deterministic test. Database changes require an additive, numbered migration. Do not include credentials, real customer lead data, or OAuth tokens in issues, fixtures, logs, or commits.

By contributing, you agree that your contributions are licensed under AGPL-3.0-only.
