import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { subscription } from '../db/schema.js';

export type SubscriptionPlan = 'free' | 'pro' | 'max';
export type PaidSubscriptionPlan = Exclude<SubscriptionPlan, 'free'>;

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

export async function getUserPlan(userId: string): Promise<UserPlanInfo> {
  const rows = await db
    .select()
    .from(subscription)
    .where(eq(subscription.userId, userId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    const now = new Date();
    const referralCode = generateReferralCode();
    await db.insert(subscription).values({
      userId,
      plan: 'free',
      autoSyncEnabled: true,
      referralCode,
      createdAt: now,
      updatedAt: now,
    });
    return {
      plan: 'free',
      expiresAt: null,
      isPaidActive: false,
      isProActive: false,
      isMaxActive: false,
      canAutoSync: false,
      canUseAi: false,
      autoSyncEnabled: true,
      lastAutoSyncAt: null,
      referralCode,
    };
  }
  let referralCode = row.referralCode;
  if (!referralCode) {
    referralCode = generateReferralCode();
    await db
      .update(subscription)
      .set({ referralCode, updatedAt: new Date() })
      .where(eq(subscription.userId, userId));
  }
  const now = new Date();
  const storedPlan = normalizePlan(row.plan);
  const isPaidActive =
    storedPlan !== 'free' && (!row.expiresAt || row.expiresAt > now);
  const activePlan = isPaidActive ? storedPlan : 'free';
  return {
    plan: activePlan,
    expiresAt: row.expiresAt,
    isPaidActive,
    isProActive: isPaidActive,
    isMaxActive: activePlan === 'max',
    canAutoSync: activePlan === 'pro' || activePlan === 'max',
    canUseAi: activePlan === 'max',
    autoSyncEnabled: row.autoSyncEnabled,
    lastAutoSyncAt: row.lastAutoSyncAt,
    referralCode,
  };
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
