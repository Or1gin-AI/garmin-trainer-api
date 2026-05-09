# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The umbrella `../CLAUDE.md` covers cross-repo context (deployment, domain layout, Garmin login design constraints). Read it first if you arrive cold.

## Commands

```bash
pnpm install
pnpm dev              # tsx watch src/server.ts (default :4001)
pnpm dev:worker       # tsx watch src/worker/index.ts — separate process
pnpm build            # tsc -p tsconfig.json → dist/
pnpm start            # node dist/server.js (production)
pnpm start:worker     # node dist/worker/index.js
pnpm start:migrate    # node dist/scripts/migrate.js — applies drizzle/*.sql
pnpm db:generate      # drizzle-kit generate after schema.ts changes
pnpm codes:gen        # tsx src/scripts/generate-codes.ts (admin tool)
```

There is no test, lint, or unit-test runner. Truth comes from `pnpm build` (tsc) + the e2e curl smoke tests in commit messages / chat history.

The Dockerfile is multi-stage (builder pulls all deps + runs `pnpm build`; production image installs `--prod` only and copies `dist/` + `drizzle/`). It uses `tini` as PID 1 because the worker spawns `decompress` child processes during sync.

## Architecture

```
src/
├── server.ts              # Express entrypoint. Mounts BetterAuth handler
│                          # BEFORE express.json() — BetterAuth needs raw body.
├── lib/
│   ├── auth.ts            # BetterAuth + drizzleAdapter + username plugin +
│   │                      # sendResetPassword wired to Resend
│   ├── crypto.ts          # AES-256-GCM. Per-user key = HKDF(sha256,
│   │                      #   master=APP_ENCRYPTION_KEY, salt=`user:${userId}`,
│   │                      #   info='garmin-trainer/v1')
│   ├── mailer.ts          # Resend wrapper. Logs to stderr if RESEND_API_KEY
│   │                      # missing instead of throwing — see umbrella note.
│   ├── plan.ts            # getUserPlan, extendProSubscription, autoSync flags
│   └── session.ts         # requireUser / requireAdmin Express middleware
├── db/
│   ├── schema.ts          # Drizzle schema (BetterAuth + subscription +
│   │                      #   redemption_code + garmin_account + sync_job)
│   └── index.ts           # pg.Pool + drizzle, with HMR-safe global cache
├── garmin/
│   ├── client.ts          # authenticateWithBrowserTicket
│   │                      # (the ticket exchange used by /api/garmin/callback),
│   │                      # authenticate (load cached session — NO password fallback)
│   ├── sync.ts            # runCnToGlobalSync — direct port of upstream
│   ├── store.ts           # per-user load/persist/clear of encrypted Garmin
│   │                      #   sessions in `garmin_account` table
│   └── utils.ts           # signature, mapActivity, isRetryableTransferError, …
├── routes/                # /me, /garmin, /sync, /redemption, /admin
├── scripts/
│   ├── migrate.ts         # production migration runner
│   ├── promote-admin.ts   # tsx … <email> — first-admin bootstrap
│   └── generate-codes.ts  # admin offline batch
└── worker/
    └── index.ts           # postgres-backed job queue + 2h auto-sync cron
                           # claims via FOR UPDATE SKIP LOCKED so multiple
                           # worker replicas are safe.
drizzle/                   # checked-in SQL migrations (drizzle-kit output)
```

### Auth state machine

- BetterAuth + drizzle adapter manages `user`/`session`/`account`/`verification`.
- The `username` plugin adds `username` (lowercase, unique) + `displayUsername`. Validator widened to `\p{L}\p{N}_-` (2–30) so Chinese nicknames are valid.
- Frontend identifies email vs username on sign-in by `@` presence. Email signs in via `signIn.email`; otherwise via `signIn.username`.
- `sendResetPassword` builds an HTML mail and sends via Resend; absent key → log + URL to stderr (operator must hand-forward until configured).

### Garmin sync

- Cloud-only path is browser-ticket: frontend hosts gauth-widget → user logs in inside Garmin's iframe → `serviceTicket` event → frontend POSTs to `/api/garmin/callback/:region` → backend `authenticateWithBrowserTicket(userId, region, ticket)` exchanges via `getOauth1Token` (matches `login-url=GARMIN_SSO_EMBED` hardcoded in lib) → encrypted `oauth1`+`oauth2` saved to `garmin_account.session_enc`.
- `authenticate(userId, region)` only loads the cached session; on failure it clears and throws "请重新连接". There is intentionally no password fallback — see umbrella for rationale.
- Sync queue: `POST /api/sync/jobs` inserts a `queued` row. Worker claims one with:
  ```sql
  UPDATE sync_job SET status='running', started_at=NOW()
  WHERE id = (SELECT id FROM sync_job WHERE status='queued'
              ORDER BY queued_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
  ```
- Cron (`*/10 * * * *`) selects Pro users with `auto_sync_enabled = true` whose `last_auto_sync_at` is older than 2h, and enqueues `incremental` jobs. Skips users without both regions' Garmin accounts.

### Subscription / cards

`subscription` is one row per user (lazy-created on first GET `/api/me`). `extendProSubscription(userId, days)` stacks days onto `expiresAt` (or now() if expired). Card redemption is one atomic SQL: `UPDATE redemption_code … WHERE code=$1 AND used_by IS NULL`.

## Production (originai server)

Image `ghcr.io/or1gin-ai/garmin-trainer-api:latest-dev` (main) / `:latest` (publish branch). Server compose at `/home/originai/garmin-trainer-api/`. Postgres host port 5557 (5556 was taken by ticket-system). All other originai services own ports 3000/3001/4000/4001 — do not collide.

Caddy block (in `/etc/caddy/Caddyfile`, sudo required to edit):
```
api.garmin-trainer.uk {
    reverse_proxy localhost:4001
}
```

## Don't

- Don't add a "save Garmin username/password" route without first restoring per-user `MFAManager` polling — the lib's password login throws "需要MFA验证" mid-flight, and the cloud needs an explicit flow for the user to submit the code asynchronously.
- Keep the frontend's `redirectAfterAccountLoginUrl` on `sso.garmin.{cn,com}/sso/embed`, because `getOauth1Token` exchanges with `login-url=sso/embed`. Do not set GAUTH's `target` option; Garmin's widget script will navigate away before the frontend callback POST can finish.
- Don't `pnpm db:push` against production — always go through generated migrations + `pnpm start:migrate`.
