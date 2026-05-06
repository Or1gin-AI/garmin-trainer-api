import { Router } from 'express';
import { z } from 'zod';
import { eq, desc } from 'drizzle-orm';
import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { redemptionCode, user, subscription } from '../db/schema.js';
import { requireAdmin } from '../lib/session.js';

export const adminRouter = Router();

const generateSchema = z.object({
  count: z.number().int().min(1).max(1000).default(10),
  planDays: z.number().int().min(1).max(3650),
  prefix: z.string().regex(/^[A-Z0-9]{0,8}$/).optional(),
  note: z.string().max(200).optional(),
});

function randomCode(prefix = ''): string {
  // 16 chars total, 4-4-4-4
  const raw = crypto.randomBytes(12).toString('base64url').toUpperCase().replace(/[-_]/g, '');
  const body = raw.slice(0, 16).padEnd(16, 'X');
  const grouped = body.match(/.{1,4}/g)!.join('-');
  return prefix ? `${prefix}-${grouped}` : grouped;
}

adminRouter.post('/codes', requireAdmin, async (req, res) => {
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid', issues: parsed.error.issues });
    return;
  }
  const { count, planDays, prefix, note } = parsed.data;
  const batchId = crypto.randomUUID();
  const codes: string[] = [];
  const seen = new Set<string>();
  while (codes.length < count) {
    const code = randomCode(prefix);
    if (seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  const now = new Date();
  await db.insert(redemptionCode).values(
    codes.map((c) => ({
      code: c,
      planDays,
      batchId,
      note: note ?? null,
      createdAt: now,
    })),
  );
  res.json({ batchId, planDays, count, codes });
});

adminRouter.get('/codes', requireAdmin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = await db
    .select()
    .from(redemptionCode)
    .orderBy(desc(redemptionCode.createdAt))
    .limit(limit);
  res.json({ codes: rows });
});

adminRouter.get('/users', requireAdmin, async (_req, res) => {
  const rows = await db
    .select({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      createdAt: user.createdAt,
    })
    .from(user)
    .orderBy(desc(user.createdAt))
    .limit(200);
  res.json({ users: rows });
});

const grantSchema = z.object({
  userId: z.string().min(1),
  planDays: z.number().int().min(1).max(3650),
});

adminRouter.post('/grant', requireAdmin, async (req, res) => {
  const parsed = grantSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid' });
    return;
  }
  const { userId, planDays } = parsed.data;
  const now = new Date();
  const existing = (
    await db.select().from(subscription).where(eq(subscription.userId, userId)).limit(1)
  )[0];
  const baseTime =
    existing?.expiresAt && existing.expiresAt > now
      ? existing.expiresAt.getTime()
      : now.getTime();
  const expiresAt = new Date(baseTime + planDays * 86400000);
  if (existing) {
    await db
      .update(subscription)
      .set({ plan: 'pro', expiresAt, updatedAt: now })
      .where(eq(subscription.userId, userId));
  } else {
    await db.insert(subscription).values({
      userId,
      plan: 'pro',
      expiresAt,
      autoSyncEnabled: true,
      createdAt: now,
      updatedAt: now,
    });
  }
  res.json({ ok: true, expiresAt });
});
