import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { subscription } from '../db/schema.js';

export type SubscriptionPlan = 'free' | 'pro' | 'max';
export type PaidSubscriptionPlan = Exclude<SubscriptionPlan, 'free'>;

// 限时活动：活动期内所有用户免费享受 Max，到期日统一为 PROMO_FREE_MAX_END。
// 活动结束后自动回退到用户真实的订阅状态。不写库以保证幂等且活动自然失效。
export const PROMO_FREE_MAX_END = new Date('2026-06-15T23:59:59Z');

export interface UserPlanInfo {
  plan: SubscriptionPlan;
  expiresAt: Date | null;
  isPaidActive: boolean;
  isProActive: boolean;
  isMaxActive: boolean;
  canAutoSync: boolean;
  canUseAi: boolean;
  autoSyncEnabled: boolean;
  lastAutoSyncAt: Date | null;
  referralCode: string;
  promoFreeMaxUntil: string | null;
}

function generateReferralCode(): string {
  return crypto.randomBytes(4).toString('base64url').toUpperCase().slice(0, 6);
}

function normalizePlan(plan: string): SubscriptionPlan {
  return plan === 'pro' || plan === 'max' ? plan : 'free';
}

function higherPaidPlan(
  current: SubscriptionPlan,
  next: PaidSubscriptionPlan,
): PaidSubscriptionPlan {
  return current === 'max' || next === 'max' ? 'max' : 'pro';
}

function applyPromo(params: {
  storedPlan: SubscriptionPlan;
  storedExpiresAt: Date | null;
  autoSyncEnabled: boolean;
  lastAutoSyncAt: Date | null;
  referralCode: string;
  now: Date;
}): UserPlanInfo {
  const {
    storedPlan, storedExpiresAt, autoSyncEnabled, lastAutoSyncAt, referralCode, now,
  } = params;

  const storedActive =
    storedPlan !== 'free' && (!storedExpiresAt || storedExpiresAt > now);
  let activePlan: SubscriptionPlan = storedActive ? storedPlan : 'free';
  let activeExpiresAt = storedActive ? storedExpiresAt : null;

  const promoActive = now < PROMO_FREE_MAX_END;
  if (promoActive) {
    const realMaxUntil = activePlan === 'max' ? activeExpiresAt : null;
    if (!realMaxUntil || realMaxUntil < PROMO_FREE_MAX_END) {
      activePlan = 'max';
      activeExpiresAt = PROMO_FREE_MAX_END;
    }
  }

  const isPaidActive = activePlan !== 'free';
  const isMaxActive = activePlan === 'max';
  return {
    plan: activePlan,
    expiresAt: activeExpiresAt,
    isPaidActive,
    isProActive: isPaidActive,
    isMaxActive,
    canAutoSync: isPaidActive,
    canUseAi: isMaxActive,
    autoSyncEnabled,
    lastAutoSyncAt,
    referralCode,
    promoFreeMaxUntil: promoActive ? PROMO_FREE_MAX_END.toISOString() : null,
  };
}

export async function getUserPlan(userId: string): Promise<UserPlanInfo> {
  const rows = await db
    .select()
    .from(subscription)
    .where(eq(subscription.userId, userId))
    .limit(1);
  const row = rows[0];
  const now = new Date();
  if (!row) {
    const referralCode = generateReferralCode();
    await db.insert(subscription).values({
      userId,
      plan: 'free',
      autoSyncEnabled: true,
      referralCode,
      createdAt: now,
      updatedAt: now,
    });
    return applyPromo({
      storedPlan: 'free',
      storedExpiresAt: null,
      autoSyncEnabled: true,
      lastAutoSyncAt: null,
      referralCode,
      now,
    });
  }
  let referralCode = row.referralCode;
  if (!referralCode) {
    referralCode = generateReferralCode();
    await db
      .update(subscription)
      .set({ referralCode, updatedAt: new Date() })
      .where(eq(subscription.userId, userId));
  }
  return applyPromo({
    storedPlan: normalizePlan(row.plan),
    storedExpiresAt: row.expiresAt,
    autoSyncEnabled: row.autoSyncEnabled,
    lastAutoSyncAt: row.lastAutoSyncAt,
    referralCode,
    now,
  });
}

export async function extendPlanSubscription(
  userId: string,
  plan: PaidSubscriptionPlan,
  days: number,
) {
  const now = new Date();
  const existing = (
    await db
      .select()
      .from(subscription)
      .where(eq(subscription.userId, userId))
      .limit(1)
  )[0];
  const baseTime = existing?.expiresAt && existing.expiresAt > now
    ? existing.expiresAt.getTime()
    : now.getTime();
  const newExpiresAt = new Date(baseTime + days * 24 * 60 * 60 * 1000);
  const storedPlan = normalizePlan(existing?.plan ?? 'free');
  const targetPlan =
    existing?.expiresAt && existing.expiresAt > now
      ? higherPaidPlan(storedPlan, plan)
      : plan;
  if (existing) {
    await db
      .update(subscription)
      .set({ plan: targetPlan, expiresAt: newExpiresAt, updatedAt: now })
      .where(eq(subscription.userId, userId));
  } else {
    await db.insert(subscription).values({
      userId,
      plan: targetPlan,
      expiresAt: newExpiresAt,
      autoSyncEnabled: true,
      createdAt: now,
      updatedAt: now,
    });
  }
  return newExpiresAt;
}

export async function extendProSubscription(userId: string, days: number) {
  return extendPlanSubscription(userId, 'pro', days);
}

export async function extendMaxSubscription(userId: string, days: number) {
  return extendPlanSubscription(userId, 'max', days);
}

export async function setAutoSyncEnabled(userId: string, enabled: boolean) {
  await db
    .update(subscription)
    .set({ autoSyncEnabled: enabled, updatedAt: new Date() })
    .where(eq(subscription.userId, userId));
}

export async function markAutoSync(userId: string) {
  await db
    .update(subscription)
    .set({ lastAutoSyncAt: new Date(), updatedAt: new Date() })
    .where(eq(subscription.userId, userId));
}
