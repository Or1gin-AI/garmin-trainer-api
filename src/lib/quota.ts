import crypto from 'node:crypto';
import { sql, eq, and } from 'drizzle-orm';
import type { RequestHandler } from 'express';
import { db } from '../db/index.js';
import { aiUsage } from '../db/schema.js';
import { getUserPlan } from './plan.js';
import type { AuthedRequest } from './session.js';

export type QuotaKind = 'plan_generation' | 'chat_message';

export const QUOTA_DEFAULTS: Record<QuotaKind, number> = {
  plan_generation: 8,
  chat_message: 200,
};

const QUOTA_FEATURE_LABELS: Record<QuotaKind, string> = {
  plan_generation: 'AI 训练计划生成（包含高级训练计划）',
  chat_message: 'AI 教练对话',
};

function maxRequiredMessage(kind: QuotaKind): string {
  return `${QUOTA_FEATURE_LABELS[kind]}是 Max 会员功能。当前账号是免费版、Plus，或 Max 已过期，所以暂时不能使用；升级或兑换 Max 后即可解锁。`;
}

/**
 * First day of the current month, midnight UTC, formatted YYYY-MM-DD.
 * Drizzle's `date` column accepts an ISO date string.
 */
function currentPeriodStart(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-indexed
  const mm = String(m + 1).padStart(2, '0');
  return `${y}-${mm}-01`;
}

function counterColumn(kind: QuotaKind) {
  switch (kind) {
    case 'plan_generation':
      return aiUsage.planGenerationCount;
    case 'chat_message':
      return aiUsage.chatMessageCount;
    default: {
      const _exhaustive: never = kind;
      throw new Error(`unknown quota kind: ${String(_exhaustive)}`);
    }
  }
}

async function ensureUsageRow(
  userId: string,
  periodStart: string,
): Promise<void> {
  await db
    .insert(aiUsage)
    .values({
      id: crypto.randomUUID(),
      userId,
      periodStart,
      planGenerationCount: 0,
      chatMessageCount: 0,
      inputTokens: 0,
      outputTokens: 0,
    })
    .onConflictDoNothing({
      target: [aiUsage.userId, aiUsage.periodStart],
    });
}

/**
 * Express middleware: require Max AI access.
 *
 *   1. Reads req.userId set by upstream requireUser. Returns 401 if missing.
 *   2. Reads getUserPlan(userId). Returns 402 { error: 'max_required', ... } if
 *      the plan cannot use AI (free, Pro sync-only, expired Max, etc).
 *   3. Lazily creates the ai_usage row for (userId, current month start).
 *   4. Calls next(). DOES NOT increment — call consumeQuota after
 *      the protected operation succeeds.
 */
export function requireAiPlanAndQuota(kind: QuotaKind): RequestHandler {
  if (!(kind in QUOTA_DEFAULTS)) {
    throw new Error(`unknown quota kind: ${String(kind)}`);
  }
  return (req, res, next) => {
    void (async () => {
      try {
        const userId = (req as AuthedRequest).user?.id;
        if (!userId) {
          res.status(401).json({ error: 'unauthorized' });
          return;
        }

        const plan = await getUserPlan(userId);
        if (!plan.canUseAi) {
          res.status(402).json({
            error: 'max_required',
            message: maxRequiredMessage(kind),
            feature: kind,
            featureLabel: QUOTA_FEATURE_LABELS[kind],
            requiredPlan: 'max',
            currentPlan: plan.plan,
            expiresAt: plan.expiresAt,
          });
          return;
        }

        const periodStart = currentPeriodStart();
        await ensureUsageRow(userId, periodStart);

        next();
      } catch (err) {
        console.error('[quota] middleware failed', err);
        res.status(500).json({ error: 'quota_check_failed' });
      }
    })();
  };
}

export const requireProAndQuota = requireAiPlanAndQuota;

/**
 * Atomically increment the counter for (userId, current month) by 1, plus
 * any token usage. Lazily creates the row if missing (e.g. if the middleware
 * was bypassed by a non-quota-gated path).
 *
 * Should be called AFTER the protected operation succeeded — failed
 * generations should not consume quota.
 */
export async function consumeQuota(
  userId: string,
  kind: QuotaKind,
  opts?: { inputTokens?: number; outputTokens?: number },
): Promise<void> {
  if (!(kind in QUOTA_DEFAULTS)) {
    throw new Error(`unknown quota kind: ${String(kind)}`);
  }
  const periodStart = currentPeriodStart();
  await ensureUsageRow(userId, periodStart);

  const inputTokens = Math.max(0, Math.floor(opts?.inputTokens ?? 0));
  const outputTokens = Math.max(0, Math.floor(opts?.outputTokens ?? 0));
  const col = counterColumn(kind);

  await db
    .update(aiUsage)
    .set({
      [kind === 'plan_generation' ? 'planGenerationCount' : 'chatMessageCount']:
        sql`${col} + 1`,
      inputTokens: sql`${aiUsage.inputTokens} + ${inputTokens}`,
      outputTokens: sql`${aiUsage.outputTokens} + ${outputTokens}`,
    })
    .where(
      and(eq(aiUsage.userId, userId), eq(aiUsage.periodStart, periodStart)),
    );
}
