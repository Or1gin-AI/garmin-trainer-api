import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { syncJob } from '../db/schema.js';
import { requireUser, type AuthedRequest } from '../lib/session.js';

export const syncRouter = Router();

// Manual sync triggers were removed; sync runs are exclusively created by the
// auto-sync cron in the worker. The endpoints below are read-only views the
// dashboard uses to surface job history and live progress.

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
