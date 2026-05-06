# Garmin Trainer API

Multi-tenant backend for the Garmin Trainer service. Users register, optionally
redeem a Pro code, and have their Garmin CN activities synced to Garmin Global
on demand or every 2 hours (Pro).

## Stack

- Node 20, TypeScript (ESM), Express 5
- BetterAuth (email + password) on Drizzle/Postgres
- `@gooin/garmin-connect` for Garmin login + activity transfer
- Standalone worker process: `node-cron` + Postgres-backed job queue
  (`FOR UPDATE SKIP LOCKED`)

## Layout

```
src/
├── server.ts            # Express entrypoint
├── lib/                 # auth, crypto (per-user HKDF), session, plan
├── db/                  # Drizzle schema + client
├── garmin/              # client, sync engine, store (multi-tenant)
├── routes/              # me, garmin, sync, redemption, admin
├── scripts/             # migrate, promote-admin, generate-codes
└── worker/              # job consumer + 2h auto-sync cron
drizzle/                 # generated migration SQL
```

## Local development

```bash
cp .env.example .env       # fill APP_ENCRYPTION_KEY, BETTER_AUTH_SECRET (32+ bytes)
pnpm install
pnpm db:push               # or: pnpm tsx src/scripts/migrate.ts (with DATABASE_URL set)
pnpm dev                   # API on :4001
pnpm dev:worker            # worker (separate process)
```

## Production deploy (originai pattern)

CI builds the image on push:
- `main` → `ghcr.io/or1gin-ai/garmin-trainer-api:latest-dev`
- `publish` → `:latest`

On the server (`/home/originai/garmin-trainer-api/`):
```bash
./scripts/deploy-compose.sh   # pulls, runs migrations, restarts app + worker
```

The compose file brings up postgres + migrate (oneshot) + app + worker, all from
the GHCR image. Caddy routes `garmin-api.originai.cc` → `localhost:4001`.

## First-run admin

1. Register an account through the web UI.
2. SSH to the server and run inside the api container:
   ```bash
   docker compose exec app node dist/scripts/promote-admin.js you@example.com
   ```
3. Generate a starter batch of redemption codes:
   ```bash
   docker compose exec app node dist/scripts/generate-codes.js \
     --count 20 --days 30 --prefix PRO
   ```
