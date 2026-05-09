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

/**
 * Returns the current monthly quota limit for a kind.
 * Today this is just the static default; admin overrides will land in U4.
 */
export function getQuotaLimit(kind: QuotaKind): number {
  return QUOTA_DEFAULTS[kind];
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

/**
 * First day of the NEXT month, midnight UTC. Used to tell clients when the
 * quota will reset. Returned as ISO string.
 */
function nextPeriodStart(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-indexed
  const next = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0, 0));
  return next.toISOString();
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

async function readCount(
  userId: string,
  periodStart: string,
  kind: QuotaKind,
): Promise<number> {
  const rows = await db
    .select({
      planGenerationCount: aiUsage.planGenerationCount,
      chatMessageCount: aiUsage.chatMessageCount,
    })
    .from(aiUsage)
    .where(
      and(eq(aiUsage.userId, userId), eq(aiUsage.periodStart, periodStart)),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return 0;
  return kind === 'plan_generation'
    ? row.planGenerationCount
    : row.chatMessageCount;
}

/**
 * Express middleware: require Pro + verify quota not exceeded.
 *
 *   1. Reads req.userId set by upstream requireUser. Returns 401 if missing.
 *   2. Reads getUserPlan(userId). Returns 402 { error: 'pro_required' } if
 *      plan is not currently Pro (free, expired Pro, etc).
 *   3. Lazily creates the ai_usage row for (userId, current month start).
 *   4. Looks up the current count. If >= limit, returns 402
 *      { error: 'quota_exceeded', kind, limit, used, periodEnd }.
 *   5. Otherwise calls next(). DOES NOT increment — call consumeQuota after
 *      the protected operation succeeds.
 */
export function requireProAndQuota(kind: QuotaKind): RequestHandler {
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
        if (!plan.isProActive) {
          res.status(402).json({ error: 'pro_required' });
          return;
        }

        const periodStart = currentPeriodStart();
        await ensureUsageRow(userId, periodStart);

        const used = await readCount(userId, periodStart, kind);
        const limit = getQuotaLimit(kind);
        if (used >= limit) {
          res.status(402).json({
            error: 'quota_exceeded',
            kind,
            limit,
            used,
            periodEnd: nextPeriodStart(),
          });
          return;
        }

        next();
      } catch (err) {
        console.error('[quota] middleware failed', err);
        res.status(500).json({ error: 'quota_check_failed' });
      }
    })();
  };
}

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
