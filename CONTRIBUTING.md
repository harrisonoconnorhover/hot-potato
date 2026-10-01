# Contributing

Thanks for helping make inbound routing less painful.

## Development

1. Install Node.js 22+ and Docker.
2. Configure the named owner and load the ignored `.env` into each terminal as shown in the [README](README.md#run-it).
3. Run `npm ci`.
4. Run `docker compose up -d postgres`.
5. Run `npm run db:setup`.
6. Build the remaining local packages: `npm run build --workspace @hot-potato/email-composer`, then `npm run build --workspace @hot-potato/integrations`, then `npm run build --workspace @hot-potato/worker`.
7. Run `npm run dev`; start `npm run dev:worker` separately when testing jobs. After changing a shared package or worker source, rerun that package's build command.

`db:setup` creates an empty workspace without changing one that already exists. Run `npm run db:demo` only when you want to restore the disposable sample records.

Before opening a pull request, run:

```bash
npm run format:check
npm run typecheck
npm test
npm run build
npm run test:integration
```

Keep changes focused. Routing behavior belongs in the pure router package with a deterministic test. Database changes require an additive, numbered migration. Once a migration has run in any shared or persistent environment, never edit it to add behavior; write the next numbered repair migration and test both a clean install and the upgrade path. Do not include credentials, real customer lead data, or OAuth tokens in issues, fixtures, logs, or commits.

By contributing, you agree that your contributions are licensed under AGPL-3.0-only.
