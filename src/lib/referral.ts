import crypto from 'node:crypto';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { referral, subscription, user } from '../db/schema.js';
import { extendMaxSubscription, getUserPlan } from './plan.js';

const REFERRAL_REWARD_DAYS = 15;
const MAX_REFERRAL_REWARDS = 2;

export async function registerReferralIntent(
  refereeEmail: string,
  referralCode: string,
): Promise<void> {
  const normalizedEmail = refereeEmail.trim().toLowerCase();
  const code = referralCode.trim().toUpperCase();
  const rows = await db
    .select({ userId: subscription.userId })
    .from(subscription)
    .where(eq(subscription.referralCode, code))
    .limit(1);
  if (!rows[0]) return;
  const referrerUserId = rows[0].userId;

  const referrerRows = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, referrerUserId))
    .limit(1);
  if (referrerRows[0]?.email.toLowerCase() === normalizedEmail) return;

  const completedCount = await db
    .select({ cnt: sql<number>`count(*)::int` })
    .from(referral)
    .where(
      and(
        eq(referral.referrerUserId, referrerUserId),
        eq(referral.status, 'completed'),
      ),
    );
  if ((completedCount[0]?.cnt ?? 0) >= MAX_REFERRAL_REWARDS) return;

  const id = crypto.randomUUID();
  await db
    .insert(referral)
    .values({
      id,
      referrerUserId,
      referralCode: code,
      refereeEmail: normalizedEmail,
      status: 'pending',
      rewardDays: REFERRAL_REWARD_DAYS,
    })
    .onConflictDoUpdate({
      target: referral.refereeEmail,
      set: {
        referrerUserId,
        referralCode: code,
        rewardDays: REFERRAL_REWARD_DAYS,
        status: 'pending',
        completedAt: null,
      },
      setWhere: eq(referral.status, 'pending'),
    });
}

export async function processReferralReward(
  refereeEmail: string,
): Promise<void> {
  const normalizedEmail = refereeEmail.toLowerCase();
  const rows = await db
    .select()
    .from(referral)
    .where(
      and(
        eq(referral.refereeEmail, normalizedEmail),
        eq(referral.status, 'pending'),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return;

  const refereeRows = await db
    .select({ id: user.id })
    .from(user)
    .where(sql`lower(${user.email}) = ${normalizedEmail}`)
    .limit(1);
  const refereeUserId = refereeRows[0]?.id ?? null;

  const completedCount = await db
    .select({ cnt: sql<number>`count(*)::int` })
    .from(referral)
    .where(
      and(
        eq(referral.referrerUserId, row.referrerUserId),
        eq(referral.status, 'completed'),
      ),
    );
  if ((completedCount[0]?.cnt ?? 0) >= MAX_REFERRAL_REWARDS) {
    await db
      .update(referral)
      .set({ status: 'expired', completedAt: new Date() })
      .where(eq(referral.id, row.id));
    return;
  }

  await db
    .update(referral)
    .set({
      status: 'completed',
      refereeUserId,
      completedAt: new Date(),
    })
    .where(eq(referral.id, row.id));

  await extendMaxSubscription(row.referrerUserId, row.rewardDays);
  console.log(
    `[referral] rewarded user ${row.referrerUserId} with ${row.rewardDays}d Max (referee: ${refereeEmail})`,
  );
}

export async function getReferralStats(userId: string) {
  const plan = await getUserPlan(userId);

  const stats = await db
    .select({
      cnt: sql<number>`count(*)::int`,
      days: sql<number>`coalesce(sum(${referral.rewardDays}), 0)::int`,
    })
    .from(referral)
    .where(
      and(
        eq(referral.referrerUserId, userId),
        eq(referral.status, 'completed'),
      ),
    );

  return {
    referralCode: plan.referralCode,
    completedCount: stats[0]?.cnt ?? 0,
    daysEarned: stats[0]?.days ?? 0,
    maxDays: MAX_REFERRAL_REWARDS * REFERRAL_REWARD_DAYS,
  };
}
