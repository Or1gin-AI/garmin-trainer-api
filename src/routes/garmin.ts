import { Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { garminAccount } from '../db/schema.js';
import {
  upsertGarminAccount,
  loadGarminAccount,
  deleteGarminAccount,
} from '../garmin/store.js';
import { authenticate, submitMfa } from '../garmin/client.js';
import { requireUser, type AuthedRequest } from '../lib/session.js';

export const garminRouter = Router();

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
  const summary = ['cn', 'global'].map((region) => {
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

const saveSchema = z.object({
  region: z.enum(['cn', 'global']),
  username: z.string().min(1),
  password: z.string().min(1),
});

garminRouter.post('/accounts', requireUser, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid', issues: parsed.error.issues });
    return;
  }
  await upsertGarminAccount(userId, parsed.data.region, {
    username: parsed.data.username,
    password: parsed.data.password,
  });
  res.json({ ok: true });
});

const verifySchema = z.object({
  region: z.enum(['cn', 'global']),
});

const interactiveSessions = new Map<string, string>(); // userId:region -> interactiveSessionId

garminRouter.post('/verify', requireUser, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid' });
    return;
  }
  const region = parsed.data.region;

  const account = await loadGarminAccount(userId, region);
  if (!account) {
    res.status(400).json({ error: '尚未配置该区域的 Garmin 账号' });
    return;
  }

  const interactiveSessionId = `${userId}:${region}:${Date.now()}`;
  let mfaPending = false;

  try {
    const result = await authenticate(userId, region, {
      interactiveSessionId,
      onMfaPending: () => {
        mfaPending = true;
        interactiveSessions.set(`${userId}:${region}`, interactiveSessionId);
      },
    });
    res.json({
      ok: true,
      profile: result.profile,
    });
  } catch (error) {
    if (mfaPending) {
      // MFA was requested mid-flight; the login promise rejected because the user hasn't answered yet.
      // Front-end should now collect the MFA code and POST to /verify/mfa.
      res.json({
        ok: false,
        mfaRequired: true,
        interactiveSessionId,
      });
      return;
    }
    res.status(400).json({ error: (error as Error).message });
  }
});

const mfaSchema = z.object({
  region: z.enum(['cn', 'global']),
  code: z.string().min(1),
});

garminRouter.post('/verify/mfa', requireUser, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const parsed = mfaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid' });
    return;
  }
  const key = `${userId}:${parsed.data.region}`;
  const sessionId = interactiveSessions.get(key);
  if (!sessionId) {
    res.status(400).json({ error: 'no MFA session pending' });
    return;
  }
  await submitMfa(userId, sessionId, parsed.data.code);
  interactiveSessions.delete(key);
  res.json({ ok: true });
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
