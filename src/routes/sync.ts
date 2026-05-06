import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { syncJob } from '../db/schema.js';
import { requireUser, type AuthedRequest } from '../lib/session.js';
import { getUserPlan } from '../lib/plan.js';

export const syncRouter = Router();

const enqueueSchema = z.object({
  mode: z.enum(['incremental', 'history']).default('incremental'),
  startIndex: z.number().int().min(0).optional(),
  maxActivities: z.number().int().min(1).max(10000).optional(),
});

syncRouter.post('/jobs', requireUser, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const parsed = enqueueSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid', issues: parsed.error.issues });
    return;
  }

  // Reject if user already has a queued/running job
  const active = await db
    .select({ id: syncJob.id, status: syncJob.status })
    .from(syncJob)
    .where(eq(syncJob.userId, userId))
    .orderBy(desc(syncJob.queuedAt))
    .limit(1);
  if (active[0] && (active[0].status === 'queued' || active[0].status === 'running')) {
    res.status(409).json({ error: '已有同步任务在进行中', jobId: active[0].id });
    return;
  }

  // Free users only get incremental
  if (parsed.data.mode === 'history') {
    const plan = await getUserPlan(userId);
    if (!plan.isProActive) {
      res.status(403).json({ error: 'Pro 订阅才能进行历史全量迁移' });
      return;
    }
  }

  const id = crypto.randomUUID();
  await db.insert(syncJob).values({
    id,
    userId,
    mode: parsed.data.mode,
    trigger: 'manual',
    status: 'queued',
    progress: { logs: [] },
    queuedAt: new Date(),
  });
  res.json({ jobId: id });
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
