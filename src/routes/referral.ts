import { Router } from 'express';
import { requireUser, type AuthedRequest } from '../lib/session.js';
import {
  registerReferralIntent,
  getReferralStats,
} from '../lib/referral.js';

export const referralRouter = Router();

referralRouter.post('/register-intent', async (req, res) => {
  try {
    const { email, referralCode } = req.body as {
      email?: string;
      referralCode?: string;
    };
    if (email && referralCode) {
      await registerReferralIntent(email, referralCode);
    }
  } catch (e) {
    console.error('[referral] register-intent error', e);
  }
  res.json({ ok: true });
});

referralRouter.get('/stats', requireUser, async (req, res) => {
  const u = (req as AuthedRequest).user;
  const stats = await getReferralStats(u.id);
  res.json(stats);
});
