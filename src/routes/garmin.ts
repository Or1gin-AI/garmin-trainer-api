import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { garminAccount } from '../db/schema.js';
import { deleteGarminAccount } from '../garmin/store.js';
import {
  authenticateWithBrowserTicket,
  buildBrowserLoginUrl,
} from '../garmin/client.js';
import { requireUser, loadSession, type AuthedRequest } from '../lib/session.js';

export const garminRouter = Router();

const FRONTEND_ORIGIN = (process.env.BETTER_AUTH_TRUSTED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)[0] || 'http://localhost:3001';

function apiBaseUrl(): string {
  return (process.env.BETTER_AUTH_URL || 'http://localhost:4001').replace(
    /\/+$/,
    '',
  );
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
  const summary = (['cn', 'global'] as const).map((region) => {
    const row = rows.find((r) => r.region === region);
    return {
      region,
      configured: !!row,
      hasSession: !!row?.hasSession,
      profile: row?.profile ?? null,
      lastValidatedAt: row?.lastValidatedAt ?? null,
    };
  });
  res.json({ accounts: summary });
});

/**
 * Kick off Garmin browser-ticket login. The user's browser is redirected to
 * the official Garmin SSO page; after they sign in, Garmin redirects back to
 * /api/garmin/callback/:region with `?ticket=...`.
 *
 * The user's BetterAuth session cookie is sent on the cross-site return
 * navigation (SameSite=Lax), so we can identify which user the ticket
 * belongs to without an explicit state token.
 */
garminRouter.get('/login/:region', requireUser, async (req, res) => {
  const region = req.params.region as 'cn' | 'global';
  if (region !== 'cn' && region !== 'global') {
    res.status(400).send('invalid region');
    return;
  }
  const callbackUrl = `${apiBaseUrl()}/api/garmin/callback/${region}`;
  const ssoUrl = buildBrowserLoginUrl(region, callbackUrl);
  res.redirect(302, ssoUrl);
});

/**
 * Garmin redirects here after the user logs in. We exchange the ticket for
 * OAuth1+OAuth2 tokens, persist them, then bounce the browser back to the
 * frontend's Garmin page with a status flag.
 */
garminRouter.get('/callback/:region', async (req, res) => {
  const region = req.params.region as 'cn' | 'global';
  if (region !== 'cn' && region !== 'global') {
    res.status(400).send('invalid region');
    return;
  }

  const ticket = String(req.query.ticket ?? '');
  const frontendBase = FRONTEND_ORIGIN;
  const back = (params: Record<string, string>) => {
    const u = new URL(`${frontendBase}/garmin`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return res.redirect(302, u.toString());
  };

  if (!ticket) {
    return back({ region, error: '没有收到 Garmin 返回的 ticket，请重试' });
  }

  // Identify the user from their session cookie (Lax cross-site navigation
  // does send cookies on top-level GETs).
  const session = await loadSession(req).catch(() => null);
  if (!session?.user) {
    return back({
      region,
      error: '回调时未能识别登录会话，请重新登录后再连接 Garmin',
    });
  }

  try {
    const result = await authenticateWithBrowserTicket(
      session.user.id,
      region,
      ticket,
    );
    return back({
      region,
      connected: '1',
      name: result.profile.fullName || result.profile.userName || '',
    });
  } catch (error) {
    return back({
      region,
      error: (error as Error).message,
    });
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
