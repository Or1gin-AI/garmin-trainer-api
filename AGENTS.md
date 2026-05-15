# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

The umbrella `../AGENTS.md` covers cross-repo context (deployment, domain layout, Garmin login design constraints). Read it first if you arrive cold.

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

- Cloud-only path is browser-ticket → DI: frontend's gauth-widget iframe hands us a CAS service_ticket → frontend POSTs `{ticket, serviceUrl}` to `/api/garmin/callback/:region` → backend `authenticateWithBrowserTicket(userId, region, ticket, serviceUrl)` calls `exchangeServiceTicketForDi` (`src/garmin/di-auth.ts`), which POSTs to `https://diauth.garmin.{cn,com}/di-oauth2-service/oauth/token` with `grant_type=…/grant/service_ticket` and `client_id=GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2` (with fallbacks). Returns `{access_token, refresh_token, …}`. We wrap that as the lib's `oauth2Token` (with extra `__di`/`__di_client_id`/`__region` markers) and load a placeholder `oauth1Token`. `patchDiRefresh` swaps the lib's `refreshOauth2Token` to use `refreshDiToken` and folds Garmin's native mobile headers (`X-Garmin-User-Agent`, etc.) into every connectapi request. Encrypted `{oauth1, oauth2}` then saved to `garmin_account.session_enc` — the oauth2 blob carries the DI metadata.
- `authenticate` (load cached session) refuses sessions whose oauth2 blob isn't DI-shaped — they're from before this rewrite (when the lib used the public `fc3e99d2-…` consumer key against `/oauth-service/oauth/preauthorized`, now permanently 429-banned on `garmin.com` from cloud IPs). Such rows get cleared and the user is asked to re-connect.
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

```caddyfile
api.garmin-trainer.uk {
    # SSE-friendly reverse proxy. The training endpoints
    # (/api/training/plans, /…/regenerate-day, /…/chat) emit progressive
    # events that must reach the client immediately — `flush_interval -1`
    # disables Caddy's response buffering, and the long header timeout keeps
    # an idle assistant turn from being killed mid-stream.
    reverse_proxy localhost:4001 {
        flush_interval -1
        transport http {
            response_header_timeout 600s
            dial_timeout 5s
        }
    }
}
```

The api responses already set `X-Accel-Buffering: no` (in `lib/sse.ts`); Caddy honors that header, so the `flush_interval` is belt-and-braces but worth keeping in case a different reverse proxy ends up in front.

### Operational notes for AI features

- **LLM provider keys** live in the `llm_config` table (encrypted with `APP_ENCRYPTION_KEY`). Rotate via the `/admin → AI 配置` UI: add a new row, mark it `isActive`, then delete the old one. There is no environment-variable path — keys are runtime-configurable on purpose.
- **Per-user monthly quota** defaults are hardcoded in `api/src/lib/quota.ts` as `QUOTA_DEFAULTS = { plan_generation: 8, chat_message: 200 }`. Adjusting these today requires a code change + redeploy. A `quota_override` table (admin-set per-user limits) is intentionally out of scope for U11; revisit if the global default becomes contentious. The trade-off is simplicity (no extra schema, no UI) for less flexibility.
- **Config cache TTL**: `lib/llm.ts` caches the active `llm_config` in-process for up to 60 seconds. After admin updates a config (edit / activate / delete), the FIRST request to a quota-gated endpoint may still use the previous config for up to ~1 minute. Activating a config calls `clearLlmConfigCache()` synchronously inside the same process, but if the api runs as multiple workers each worker has its own cache, so cross-worker propagation is bounded by the TTL.
- **Quota enforcement**: `requireProAndQuota(kind)` checks the counter before the operation; `consumeQuota(userId, kind, …)` increments only after the SSE `done` event is emitted (i.e. after the persistence transaction commits). Failed generations / chats do not increment, so a transient LLM outage can't burn a user's monthly budget. Quota errors during increment are logged (`console.error`) but never propagated to the client — the user already received their successful response.
- **Admin usage view**: `GET /api/admin/ai-usage?periodStart=YYYY-MM-DD` joins `ai_usage` with `user`. Powers the `/admin → 用量` tab.

## Don't

- Don't add a "save Garmin username/password" route without first restoring per-user `MFAManager` polling — the lib's password login throws "需要MFA验证" mid-flight, and the cloud needs an explicit flow for the user to submit the code asynchronously.
- Keep the frontend's `redirectAfterAccountLoginUrl` on `sso.garmin.{cn,com}/sso/embed`, because `getOauth1Token` exchanges with `login-url=sso/embed`. Do not set GAUTH's `target` option; Garmin's widget script will navigate away before the frontend callback POST can finish.
- Don't `pnpm db:push` against production — always go through generated migrations + `pnpm start:migrate`.
