import { Router } from 'express';
import crypto from 'node:crypto';
import { and, desc, eq, or } from 'drizzle-orm';
import { db } from '../db/index.js';
import { garminAccount, syncJob } from '../db/schema.js';
import { requireUser, type AuthedRequest } from '../lib/session.js';
import { getUserPlan } from '../lib/plan.js';

export const syncRouter = Router();

syncRouter.post('/jobs', requireUser, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const mode = req.body?.mode === 'history' ? 'history' : 'incremental';

  try {
    const plan = await getUserPlan(userId);
    if (!plan.canAutoSync) {
      res.status(402).json({
        error: 'plus_required',
        message:
          'Garmin sync is a Plus / Max feature. Your account does not have an active Plus plan. Upgrade or redeem a code to run manual syncs and enable auto-sync.',
        requiredPlan: 'plus',
        currentPlan: plan.plan,
        expiresAt: plan.expiresAt,
      });
      return;
    }

    const active = await db
      .select({ id: syncJob.id, status: syncJob.status })
      .from(syncJob)
      .where(
        and(
          eq(syncJob.userId, userId),
          or(eq(syncJob.status, 'queued'), eq(syncJob.status, 'running')),
        ),
      )
      .limit(1);
    if (active[0]) {
      res.status(409).json({
        error: 'sync_job_active',
        message: 'A sync job is already queued or running. Please wait for it to finish before starting a new one.',
        jobId: active[0].id,
        status: active[0].status,
      });
      return;
    }

    const accounts = await db
      .select({
        region: garminAccount.region,
        sessionEnc: garminAccount.sessionEnc,
      })
      .from(garminAccount)
      .where(eq(garminAccount.userId, userId));
    const byRegion = new Map(accounts.map((a) => [a.region, a.sessionEnc]));
    const missingRegions = (['cn', 'global'] as const).filter((r) => !byRegion.get(r));
    if (missingRegions.length > 0) {
      res.status(400).json({
        error: 'garmin_accounts_missing',
        message: `Please reconnect your ${missingRegions
          .map((r) => (r === 'cn' ? 'China region' : 'Global region'))
          .join(' and ')} Garmin account on the "Garmin Accounts" page before syncing.`,
        missingRegions,
      });
      return;
    }

    const id = crypto.randomUUID();
    await db.insert(syncJob).values({
      id,
      userId,
      mode,
      trigger: 'manual',
      status: 'queued',
      progress: { logs: [] },
      queuedAt: new Date(),
    });

    const rows = await db
      .select()
      .from(syncJob)
      .where(eq(syncJob.id, id))
      .limit(1);
    res.status(201).json({ job: rows[0] });
  } catch (err) {
    console.error('[sync] enqueue failed:', err);
    res.status(500).json({
      error: 'sync_enqueue_failed',
      message: 'Failed to create the sync job. Please try again later.',
    });
  }
});

syncRouter.get('/jobs', requireUser, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const rows = await db
    .select()
    .from(syncJob)
    .where(eq(syncJob.userId, userId))
    .orderBy(desc(syncJob.queuedAt))
    .limit(20);
  res.json({ jobs: rows });
});

syncRouter.get('/jobs/:id', requireUser, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const rows = await db
    .select()
    .from(syncJob)
    .where(and(eq(syncJob.id, String(req.params.id)), eq(syncJob.userId, userId)))
    .limit(1);
  if (!rows[0]) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ job: rows[0] });
});

syncRouter.get('/jobs/current/status', requireUser, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const rows = await db
    .select()
    .from(syncJob)
    .where(eq(syncJob.userId, userId))
    .orderBy(desc(syncJob.queuedAt))
    .limit(1);
  res.json({ job: rows[0] ?? null });
});
