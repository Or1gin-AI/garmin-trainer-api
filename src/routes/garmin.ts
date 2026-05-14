import crypto from 'node:crypto';
import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { garminAccount, garminBindLog } from '../db/schema.js';
import { deleteGarminAccount } from '../garmin/store.js';
import { authenticateWithBrowserTicket } from '../garmin/client.js';
import { requireUser, type AuthedRequest } from '../lib/session.js';

export const garminRouter = Router();

const FRONTEND_ORIGIN = (process.env.BETTER_AUTH_TRUSTED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)[0] || 'http://localhost:3001';
const GARMIN_BIND_COOLDOWN_DAYS = 7;
const GARMIN_BIND_COOLDOWN_MS = GARMIN_BIND_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

type Region = 'cn' | 'global';

async function getBindCooldown(userId: string, region: Region, now = new Date()) {
  const latest = (
    await db
      .select({ boundAt: garminBindLog.boundAt })
      .from(garminBindLog)
      .where(and(eq(garminBindLog.userId, userId), eq(garminBindLog.region, region)))
      .orderBy(desc(garminBindLog.boundAt))
      .limit(1)
  )[0] ?? null;

  if (!latest?.boundAt) {
    return { lastBoundAt: null, nextBindAllowedAt: null, canBind: true };
  }

  const next = new Date(latest.boundAt.getTime() + GARMIN_BIND_COOLDOWN_MS);
  return {
    lastBoundAt: latest.boundAt,
    nextBindAllowedAt: next,
    canBind: next <= now,
  };
}

async function recordSuccessfulBind(
  userId: string,
  region: Region,
  profile: { fullName?: string; userName?: string; location?: string } | null,
) {
  await db.insert(garminBindLog).values({
    id: crypto.randomUUID(),
    userId,
    region,
    profile,
    boundAt: new Date(),
  });
}

garminRouter.get('/accounts', requireUser, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const rows = await db
    .select({
      region: garminAccount.region,
      profile: garminAccount.profile,
      lastValidatedAt: garminAccount.lastValidatedAt,
      hasSession: garminAccount.sessionEnc,
    })
    .from(garminAccount)
    .where(eq(garminAccount.userId, userId));
  const summary = await Promise.all((['cn', 'global'] as const).map(async (region) => {
    const row = rows.find((r) => r.region === region);
    const cooldown = await getBindCooldown(userId, region);
    return {
      region,
      configured: !!row,
      hasSession: !!row?.hasSession,
      profile: row?.profile ?? null,
      lastValidatedAt: row?.lastValidatedAt ?? null,
      lastBoundAt: cooldown.lastBoundAt,
      nextBindAllowedAt: cooldown.nextBindAllowedAt,
      canBind: cooldown.canBind,
    };
  }));
  res.json({ accounts: summary });
});

/**
 * Legacy compatibility — bounce to the frontend's widget-embedded connect page.
 * Garmin's SSO does NOT redirect tickets to arbitrary external URLs, so we
 * can't run a pure CAS-style flow against api.garmin-trainer.uk. Instead the
 * frontend hosts Garmin's official `gauth-widget.js`, which emits the service
 * ticket via a JS event after the user signs in, and POSTs it back here.
 */
garminRouter.get('/login/:region', requireUser, async (req, res) => {
  const region = req.params.region as 'cn' | 'global';
  if (region !== 'cn' && region !== 'global') {
    res.status(400).send('invalid region');
    return;
  }
  res.redirect(302, `${FRONTEND_ORIGIN}/garmin/connect/${region}`);
});

/**
 * Receive the service ticket extracted by the gauth-widget on the frontend.
 * Exchanges the ticket for OAuth1+OAuth2 tokens via @gooin/garmin-connect
 * (which expects login-url=sso/embed — same URL the widget targets, so the
 * exchange succeeds).
 */
garminRouter.post('/callback/:region', requireUser, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const region = req.params.region as Region;
  if (region !== 'cn' && region !== 'global') {
    res.status(400).json({ ok: false, error: 'invalid region' });
    return;
  }
  const ticket = String((req.body && req.body.ticket) || '').trim();
  if (!ticket) {
    res.status(400).json({ ok: false, error: '缺少 ticket' });
    return;
  }
  const rawServiceUrl = req.body && req.body.serviceUrl;
  const serviceUrl =
    typeof rawServiceUrl === 'string' && rawServiceUrl.trim() ? rawServiceUrl.trim() : null;
  try {
    const cooldown = await getBindCooldown(userId, region);
    if (!cooldown.canBind) {
      res.status(429).json({
        ok: false,
        error: `同一区域 Garmin 账号 7 天内只能绑定一次，请在 ${cooldown.nextBindAllowedAt?.toLocaleString('zh-CN')} 后再试。`,
        code: 'garmin_bind_cooldown',
        nextBindAllowedAt: cooldown.nextBindAllowedAt,
      });
      return;
    }
    const result = await authenticateWithBrowserTicket(userId, region, ticket, serviceUrl);
    await recordSuccessfulBind(userId, region, result.profile);
    res.json({ ok: true, profile: result.profile });
  } catch (error) {
    res.status(400).json({ ok: false, error: (error as Error).message });
  }
});

garminRouter.delete('/accounts/:region', requireUser, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const region = req.params.region as 'cn' | 'global';
  if (region !== 'cn' && region !== 'global') {
    res.status(400).json({ error: 'invalid region' });
    return;
  }
  await deleteGarminAccount(userId, region);
  res.json({ ok: true });
});
