import { Router } from 'express';
import { z } from 'zod';
import { eq, isNull, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { redemptionCode } from '../db/schema.js';
import { requireUser, type AuthedRequest } from '../lib/session.js';
import {
  extendPlanSubscription,
  getUserPlan,
  type PaidSubscriptionPlan,
} from '../lib/plan.js';

export const redemptionRouter = Router();

const redeemSchema = z.object({
  code: z.string().min(4).max(64),
});

redemptionRouter.post('/redeem', requireUser, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const parsed = redeemSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid' });
    return;
  }
  const code = parsed.data.code.trim().toUpperCase();

  // Atomic claim: only update if currently unused
  const claimed = await db
    .update(redemptionCode)
    .set({ usedBy: userId, usedAt: new Date() })
    .where(and(eq(redemptionCode.code, code), isNull(redemptionCode.usedBy)))
    .returning();

  if (!claimed[0]) {
    // Distinguish "not found" vs "already used"
    const found = await db
      .select()
      .from(redemptionCode)
      .where(eq(redemptionCode.code, code))
      .limit(1);
    if (!found[0]) {
      res.status(404).json({ error: '卡密不存在' });
      return;
    }
    res.status(409).json({ error: '卡密已被使用' });
    return;
  }

  const planName: PaidSubscriptionPlan = claimed[0].plan === 'pro' ? 'pro' : 'max';
  const newExpiresAt = await extendPlanSubscription(
    userId,
    planName,
    claimed[0].planDays,
  );
  const plan = await getUserPlan(userId);
  res.json({
    ok: true,
    subscriptionPlan: planName,
    planDays: claimed[0].planDays,
    expiresAt: newExpiresAt,
    plan,
  });
});
