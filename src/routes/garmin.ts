import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { garminAccount } from '../db/schema.js';
import { deleteGarminAccount } from '../garmin/store.js';
import { authenticateWithBrowserTicket } from '../garmin/client.js';
import { requireUser, type AuthedRequest } from '../lib/session.js';

export const garminRouter = Router();

const FRONTEND_ORIGIN = (process.env.BETTER_AUTH_TRUSTED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)[0] || 'http://localhost:3001';

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
  const region = req.params.region as 'cn' | 'global';
  if (region !== 'cn' && region !== 'global') {
    res.status(400).json({ ok: false, error: 'invalid region' });
    return;
  }
  const ticket = String((req.body && req.body.ticket) || '').trim();
  if (!ticket) {
    res.status(400).json({ ok: false, error: '缺少 ticket' });
    return;
  }
  try {
    const result = await authenticateWithBrowserTicket(userId, region, ticket);
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
