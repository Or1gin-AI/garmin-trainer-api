import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq, ilike, or } from 'drizzle-orm';
import crypto from 'node:crypto';
import { db } from '../db/index.js';
import {
  chatMessage,
  redemptionCode,
  subscription,
  trainingPlan,
  user,
} from '../db/schema.js';
import { requireAdmin } from '../lib/session.js';
import { extendPlanSubscription, type PaidSubscriptionPlan } from '../lib/plan.js';

export const adminRouter = Router();

const generateSchema = z.object({
  count: z.number().int().min(1).max(1000).default(10),
  plan: z.enum(['pro', 'max']).default('max'),
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
  const { count, plan, planDays, prefix, note } = parsed.data;
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
      plan,
      planDays,
      batchId,
      note: note ?? null,
      createdAt: now,
    })),
  );
  res.json({ batchId, plan, planDays, count, codes });
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

const listUsersSchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

adminRouter.get('/users', requireAdmin, async (req, res) => {
  const parsed = listUsersSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid', issues: parsed.error.issues });
    return;
  }
  const { q, limit } = parsed.data;
  const where = q
    ? or(
        ilike(user.email, `%${q}%`),
        ilike(user.name, `%${q}%`),
        ilike(user.displayUsername, `%${q}%`),
      )
    : undefined;
  const rows = await db
    .select({
      id: user.id,
      email: user.email,
      name: user.name,
      displayUsername: user.displayUsername,
      emailVerified: user.emailVerified,
      role: user.role,
      createdAt: user.createdAt,
      plan: subscription.plan,
      expiresAt: subscription.expiresAt,
      autoSyncEnabled: subscription.autoSyncEnabled,
    })
    .from(user)
    .leftJoin(subscription, eq(subscription.userId, user.id))
    .where(where)
    .orderBy(desc(user.createdAt))
    .limit(limit);
  res.json({ users: rows });
});

const listChatMessagesSchema = z.object({
  userId: z.string().min(1).optional(),
  planId: z.string().min(1).optional(),
  role: z.enum(['user', 'assistant', 'tool']).optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

adminRouter.get('/chat-messages', requireAdmin, async (req, res) => {
  const parsed = listChatMessagesSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid', issues: parsed.error.issues });
    return;
  }

  const { userId, planId, role, q, limit } = parsed.data;
  const clauses = [];
  if (userId) clauses.push(eq(chatMessage.userId, userId));
  if (planId) clauses.push(eq(chatMessage.planId, planId));
  if (role) clauses.push(eq(chatMessage.role, role));
  if (q) {
    clauses.push(
      or(
        ilike(user.email, `%${q}%`),
        ilike(user.name, `%${q}%`),
        ilike(user.displayUsername, `%${q}%`),
        ilike(chatMessage.content, `%${q}%`),
      ),
    );
  }

  const rows = await db
    .select({
      id: chatMessage.id,
      planId: chatMessage.planId,
      userId: chatMessage.userId,
      role: chatMessage.role,
      content: chatMessage.content,
      toolCalls: chatMessage.toolCalls,
      toolResultRefs: chatMessage.toolResultRefs,
      createdAt: chatMessage.createdAt,
      email: user.email,
      displayName: user.displayUsername,
      name: user.name,
      weekStartDate: trainingPlan.weekStartDate,
      planStatus: trainingPlan.status,
    })
    .from(chatMessage)
    .innerJoin(user, eq(chatMessage.userId, user.id))
    .innerJoin(trainingPlan, eq(chatMessage.planId, trainingPlan.id))
    .where(clauses.length ? and(...clauses) : undefined)
    .orderBy(desc(chatMessage.createdAt))
    .limit(limit);

  res.json({
    messages: rows.map((r) => ({
      ...r,
      displayName: r.displayName ?? r.name,
    })),
  });
});

const grantSchema = z.object({
  userId: z.string().min(1),
  plan: z.enum(['pro', 'max']).default('max'),
  planDays: z.number().int().min(1).max(3650),
});

adminRouter.post('/grant', requireAdmin, async (req, res) => {
  const parsed = grantSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid' });
    return;
  }
  const { userId, planDays } = parsed.data;
  const plan = parsed.data.plan as PaidSubscriptionPlan;
  const expiresAt = await extendPlanSubscription(userId, plan, planDays);
  res.json({ ok: true, plan, expiresAt });
});
