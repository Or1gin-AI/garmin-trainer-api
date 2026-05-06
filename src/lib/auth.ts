import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { username } from 'better-auth/plugins';
import { db } from '../db/index.js';
import * as schema from '../db/schema.js';
import { sendEmail, buildPasswordResetEmail } from './mailer.js';

const trustedOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const FRONTEND_BASE =
  trustedOrigins[0] || process.env.FRONTEND_URL || 'http://localhost:3001';

// Permissive validator: 2–30 chars, allow Chinese letters, ASCII alphanum,
// underscore, dash. No whitespace, no @ (so we can distinguish from emails
// in the unified login form).
const usernameValidator = (u: string) =>
  /^[\p{L}\p{N}_-]{2,30}$/u.test(u);

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    minPasswordLength: 8,
    sendResetPassword: async ({ user, url }) => {
      // BetterAuth's `url` includes a `callbackURL` query param. The frontend
      // should set callbackURL=https://garmin-trainer.uk/reset-password.
      const { subject, html } = buildPasswordResetEmail(user.name || '', url);
      await sendEmail(user.email, subject, html);
    },
    resetPasswordTokenExpiresIn: 3600, // 1 hour
  },
  plugins: [
    username({
      minUsernameLength: 2,
      maxUsernameLength: 30,
      usernameValidator,
      // Lowercase for case-insensitive uniqueness (Chinese chars unaffected)
      usernameNormalization: (u) => u.toLowerCase(),
      displayUsernameNormalization: (u) => u.trim(),
    }),
  ],
  user: {
    additionalFields: {
      role: {
        type: 'string',
        defaultValue: 'user',
        required: false,
        input: false,
      },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  trustedOrigins,
  advanced: {
    crossSubDomainCookies: { enabled: false },
    defaultCookieAttributes: {
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    },
  },
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
});

export const FRONTEND_RESET_URL = `${FRONTEND_BASE.replace(/\/+$/, '')}/reset-password`;
export type Auth = typeof auth;
