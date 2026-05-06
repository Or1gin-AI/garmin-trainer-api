import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

// ===== BetterAuth core tables =====

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  role: text('role').notNull().default('user'), // 'user' | 'admin'
  username: text('username').unique(), // BetterAuth username plugin: lowercased, unique
  displayUsername: text('display_username'), // BetterAuth username plugin: original case
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  idToken: text('id_token'),
  password: text('password'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// ===== Subscription =====

export const subscription = pgTable(
  'subscription',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    plan: text('plan').notNull().default('free'), // 'free' | 'pro'
    expiresAt: timestamp('expires_at'),
    autoSyncEnabled: boolean('auto_sync_enabled').notNull().default(true),
    lastAutoSyncAt: timestamp('last_auto_sync_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [index('subscription_expires_at_idx').on(t.expiresAt)],
);

// ===== Redemption code =====

export const redemptionCode = pgTable(
  'redemption_code',
  {
    code: text('code').primaryKey(),
    planDays: integer('plan_days').notNull(),
    batchId: text('batch_id'),
    note: text('note'),
    usedBy: text('used_by').references(() => user.id, { onDelete: 'set null' }),
    usedAt: timestamp('used_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('redemption_used_by_idx').on(t.usedBy)],
);

// ===== Garmin account (per region per user) =====

export const garminAccount = pgTable(
  'garmin_account',
  {
    id: text('id').primaryKey(), // userId:region
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    region: text('region').notNull(), // 'cn' | 'global'
    usernameEnc: text('username_enc').notNull(),
    passwordEnc: text('password_enc').notNull(),
    sessionEnc: text('session_enc'),
    profile: jsonb('profile').$type<{
      fullName?: string;
      userName?: string;
      location?: string;
    } | null>(),
    lastValidatedAt: timestamp('last_validated_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('garmin_account_user_region_idx').on(t.userId, t.region),
  ],
);

// ===== Sync job =====

export const syncJob = pgTable(
  'sync_job',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    mode: text('mode').notNull(), // 'incremental' | 'history'
    trigger: text('trigger').notNull(), // 'manual' | 'cron'
    status: text('status').notNull().default('queued'), // 'queued' | 'running' | 'success' | 'failed' | 'aborted'
    progress: jsonb('progress').$type<{
      total?: number;
      done?: number;
      currentName?: string;
      logs?: { at: string; level: 'info' | 'warn' | 'error'; message: string }[];
    } | null>(),
    result: jsonb('result').$type<{
      uploaded?: number;
      skipped?: number;
      failed?: number;
    } | null>(),
    error: text('error'),
    queuedAt: timestamp('queued_at').notNull().defaultNow(),
    startedAt: timestamp('started_at'),
    finishedAt: timestamp('finished_at'),
  },
  (t) => [
    index('sync_job_status_idx').on(t.status),
    index('sync_job_user_idx').on(t.userId, t.queuedAt),
  ],
);

// ===== Activity cache =====

export const activityCache = pgTable(
  'activity_cache',
  {
    id: text('id').primaryKey(), // userId:region:activityId
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    region: text('region').notNull(),
    activityId: text('activity_id').notNull(),
    data: jsonb('data').notNull(),
    fetchedAt: timestamp('fetched_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('activity_cache_user_region_act_idx').on(
      t.userId,
      t.region,
      t.activityId,
    ),
  ],
);

export type User = typeof user.$inferSelect;
export type Subscription = typeof subscription.$inferSelect;
export type RedemptionCode = typeof redemptionCode.$inferSelect;
export type GarminAccount = typeof garminAccount.$inferSelect;
export type SyncJob = typeof syncJob.$inferSelect;
