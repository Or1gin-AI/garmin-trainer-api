import { Router } from 'express';
import { z } from 'zod';
import { requireUser, type AuthedRequest } from '../lib/session.js';
import { getUserPlan, setAutoSyncEnabled } from '../lib/plan.js';

export const meRouter = Router();

meRouter.get('/', requireUser, async (req, res) => {
  const u = (req as AuthedRequest).user;
  const plan = await getUserPlan(u.id);
  res.json({ user: u, plan });
});

const autoSyncSchema = z.object({ enabled: z.boolean() });

meRouter.patch('/auto-sync', requireUser, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const parsed = autoSyncSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid' });
    return;
  }
  await setAutoSyncEnabled(userId, parsed.data.enabled);
  const plan = await getUserPlan(userId);
  res.json({ plan });
});
