import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  bigint,
  serial,
  date,
  numeric,
  jsonb,
  uniqueIndex,
  index,
  check,
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
      cnToGlobal?: { uploaded: number; skipped: number; failed: number };
      globalToCn?: { uploaded: number; skipped: number; failed: number };
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

// ===== AI Training Companion =====

// Per-user weekly training plan. One plan per (user, weekStartDate); status
// transitions: generating -> ready | failed; old plans -> archived.
export const trainingPlan = pgTable(
  'training_plan',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    weekStartDate: date('week_start_date').notNull(),
    status: text('status').notNull().default('generating'), // 'generating' | 'ready' | 'failed' | 'archived'
    request: jsonb('request').notNull(), // form payload {goal, raceDate, sports, daysPerWeek, ...}
    athleteProfileSnapshot: jsonb('athlete_profile_snapshot'), // profile + recentState at generation time, nullable until ready
    summary: text('summary'),
    monitoring: text('monitoring'),
    adjustmentRules: text('adjustment_rules'),
    modelMeta: jsonb('model_meta'), // {provider, baseUrl, model, totalTokens, costCents}
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('training_plan_user_week_idx').on(t.userId, t.weekStartDate.desc()),
    check(
      'training_plan_status_chk',
      sql`${t.status} IN ('generating','ready','failed','archived')`,
    ),
  ],
);

// Workout slots, normalized by plan/day/session. dayIndex 1..7; slotIndex
// allows double days such as AM/PM threshold sessions.
export const workout = pgTable(
  'workout',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id')
      .notNull()
      .references(() => trainingPlan.id, { onDelete: 'cascade' }),
    dayIndex: integer('day_index').notNull(),
    slotIndex: integer('slot_index').notNull().default(1),
    date: date('date').notNull(),
    sessionLabel: text('session_label'),
    timeOfDay: text('time_of_day'),
    sport: text('sport').notNull(), // 'running' | 'cycling' | 'swimming' | 'rest' | 'strength' | 'mobility'
    templateId: text('template_id').notNull(),
    workoutType: text('workout_type'),
    title: text('title').notNull(),
    intensity: text('intensity').notNull(), // 'low' | 'medium' | 'high'
    durationMinutes: integer('duration_minutes'),
    distanceKm: numeric('distance_km', { precision: 6, scale: 2 }),
    targetMetric: text('target_metric').notNull(), // 'heart_rate' | 'pace' | 'power' | 'mixed' | 'none'
    targetHeartRate: text('target_heart_rate'),
    targetPace: text('target_pace'),
    targetPower: text('target_power'),
    workoutStructure: text('workout_structure'),
    targets: jsonb('targets').$type<string[] | null>(), // string[]
    parameterSource: jsonb('parameter_source').$type<{
      templateId?: string;
      replacedVariables?: Record<string, string | number>;
      downgradeReason?: string;
    } | null>(),
    adaptation: text('adaptation'),
    status: text('status').notNull().default('planned'), // 'planned' | 'completed' | 'skipped' | 'regenerating'
  },
  (t) => [
    uniqueIndex('workout_plan_day_slot_idx').on(t.planId, t.dayIndex, t.slotIndex),
    check('workout_day_index_chk', sql`${t.dayIndex} BETWEEN 1 AND 7`),
    check('workout_slot_index_chk', sql`${t.slotIndex} BETWEEN 1 AND 3`),
    check(
      'workout_time_of_day_chk',
      sql`${t.timeOfDay} IS NULL OR ${t.timeOfDay} IN ('morning','midday','afternoon','evening')`,
    ),
    check(
      'workout_sport_chk',
      sql`${t.sport} IN ('running','cycling','swimming','rest','strength','mobility')`,
    ),
    check(
      'workout_intensity_chk',
      sql`${t.intensity} IN ('low','medium','high')`,
    ),
    check(
      'workout_target_metric_chk',
      sql`${t.targetMetric} IN ('heart_rate','pace','power','mixed','none')`,
    ),
    check(
      'workout_status_chk',
      sql`${t.status} IN ('planned','completed','skipped','regenerating')`,
    ),
  ],
);

// One lightweight calendar setting per user. The calendar always derives
// planned workouts from this active plan, so importing a new plan replaces the
// old one instead of duplicating events.
export const userCalendar = pgTable(
  'user_calendar',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    activePlanId: text('active_plan_id').references(() => trainingPlan.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [index('user_calendar_active_plan_idx').on(t.activePlanId)],
);

// Remote Garmin workout objects created by Garmin Trainer. This is the
// deletion ledger: every pushed workout/schedule must be traceable here so a
// user can remove one uploaded plan without touching unrelated Garmin data.
export const garminPushedWorkout = pgTable(
  'garmin_pushed_workout',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    planId: text('plan_id')
      .notNull()
      .references(() => trainingPlan.id, { onDelete: 'cascade' }),
    localWorkoutId: text('local_workout_id')
      .notNull()
      .references(() => workout.id, { onDelete: 'cascade' }),
    region: text('region').notNull().default('cn'), // 'cn' | 'global'
    garminWorkoutId: text('garmin_workout_id'),
    garminScheduleId: text('garmin_schedule_id'),
    scheduledDate: date('scheduled_date').notNull(),
    workoutName: text('workout_name').notNull(),
    payloadHash: text('payload_hash').notNull(),
    status: text('status').notNull().default('scheduled'), // 'scheduled' | 'deleting' | 'deleted' | 'failed'
    lastError: text('last_error'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('garmin_pushed_workout_local_region_idx').on(
      t.localWorkoutId,
      t.region,
      t.scheduledDate,
    ),
    index('garmin_pushed_workout_plan_idx').on(t.planId),
    index('garmin_pushed_workout_user_plan_idx').on(t.userId, t.planId),
    check('garmin_pushed_workout_region_chk', sql`${t.region} IN ('cn','global')`),
    check(
      'garmin_pushed_workout_status_chk',
      sql`${t.status} IN ('scheduled','deleting','deleted','failed')`,
    ),
  ],
);

// User-submitted mapping from real Garmin activities to one calendar day.
// The evaluator can later compare these selected activities with the planned
// workouts for that date and populate result.
export const trainingEvaluation = pgTable(
  'training_evaluation',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    planId: text('plan_id').references(() => trainingPlan.id, {
      onDelete: 'set null',
    }),
    evaluationDate: date('evaluation_date').notNull(),
    plannedWorkoutIds: jsonb('planned_workout_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    activityRefs: jsonb('activity_refs')
      .$type<Array<{ region: 'cn' | 'global' | 'manual'; activityId: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: text('status').notNull().default('pending'), // 'pending' | 'ready' | 'failed'
    result: jsonb('result'),
    note: text('note'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('training_evaluation_user_date_idx').on(t.userId, t.evaluationDate),
    index('training_evaluation_plan_idx').on(t.planId),
    check(
      'training_evaluation_status_chk',
      sql`${t.status} IN ('pending','ready','failed')`,
    ),
  ],
);

// Companion chat history. userId is denormalized for query convenience.
export const chatMessage = pgTable(
  'chat_message',
  {
    id: text('id').primaryKey(),
    planId: text('plan_id')
      .notNull()
      .references(() => trainingPlan.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').notNull(), // 'user' | 'assistant' | 'tool'
    content: text('content').notNull(),
    toolCalls: jsonb('tool_calls').$type<
      { name: string; arguments: unknown }[] | null
    >(),
    toolResultRefs: jsonb('tool_result_refs').$type<
      { workoutId: string; before: unknown; after: unknown }[] | null
    >(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('chat_message_plan_created_idx').on(t.planId, t.createdAt),
    index('chat_message_user_idx').on(t.userId),
    check(
      'chat_message_role_chk',
      sql`${t.role} IN ('user','assistant','tool')`,
    ),
  ],
);

// Pro monthly quota counters. periodStart is the first day of the month.
export const aiUsage = pgTable(
  'ai_usage',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    periodStart: date('period_start').notNull(),
    planGenerationCount: integer('plan_generation_count').notNull().default(0),
    chatMessageCount: integer('chat_message_count').notNull().default(0),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' })
      .notNull()
      .default(0),
  },
  (t) => [uniqueIndex('ai_usage_user_period_idx').on(t.userId, t.periodStart)],
);

// Admin-managed OpenAI-compatible LLM provider config. apiKeyEncrypted holds
// the string format produced by lib/crypto.ts ("iv.tag.cipher", base64-joined),
// stored as text since it's ASCII-safe. The partial unique index on is_active
// enforces "at most one row active" at the DB level, so concurrent activates
// can't both win.
export const llmConfig = pgTable(
  'llm_config',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull().unique(), // 'primary' | 'fallback' | etc
    baseUrl: text('base_url').notNull(),
    apiKeyEncrypted: text('api_key_encrypted').notNull(),
    model: text('model').notNull(),
    maxOutputTokens: integer('max_output_tokens').notNull().default(4096),
    isActive: boolean('is_active').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('llm_config_one_active_idx')
      .on(t.isActive)
      .where(sql`${t.isActive}`),
  ],
);

export type User = typeof user.$inferSelect;
export type Subscription = typeof subscription.$inferSelect;
export type RedemptionCode = typeof redemptionCode.$inferSelect;
export type GarminAccount = typeof garminAccount.$inferSelect;
export type SyncJob = typeof syncJob.$inferSelect;
export type TrainingPlan = typeof trainingPlan.$inferSelect;
export type Workout = typeof workout.$inferSelect;
export type UserCalendar = typeof userCalendar.$inferSelect;
export type GarminPushedWorkout = typeof garminPushedWorkout.$inferSelect;
export type TrainingEvaluation = typeof trainingEvaluation.$inferSelect;
export type ChatMessage = typeof chatMessage.$inferSelect;
export type AiUsage = typeof aiUsage.$inferSelect;
export type LlmConfig = typeof llmConfig.$inferSelect;
