// Training plan routes (U7).
//
// Endpoints:
//   POST   /api/training/plans                           SSE; generate plan
//   GET    /api/training/plans                           list user's plans
//   GET    /api/training/plans/:id                       plan + workouts + chat
//   POST   /api/training/plans/:id/regenerate-day        SSE; regen one day
//   PATCH  /api/training/workouts/:id                    update status
//
// Quota middleware (`requireProAndQuota`) gates the two SSE endpoints. Quota
// CONSUMPTION is intentionally deferred to U11 — we leave a TODO marker.
//
// All endpoints require an authenticated user; ownership is checked on every
// :id route by joining through training_plan.userId.

import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  trainingPlan,
  workout,
  chatMessage,
  activityCache,
  type TrainingPlan,
  type Workout,
  type ChatMessage,
} from '../db/schema.js';
import { requireUser, type AuthedRequest } from '../lib/session.js';
import { requireProAndQuota } from '../lib/quota.js';
import { openSse, writeEvent, endSse, startHeartbeat } from '../lib/sse.js';
import { normalizeActivity } from '../training/activity-normalizer.js';
import type { NormalizedActivity } from '../training/activity-normalizer.js';
import { classifyActivityQuality } from '../training/activity-quality.js';
import type { QualityResult } from '../training/activity-quality.js';
import { deriveRecentTrainingState } from '../training/recent-state.js';
import { buildAthleteProfile } from '../training/athlete-profile.js';
import { generatePlan } from '../training/orchestrator.js';
import { buildWeeklySchedule } from '../training/scheduler.js';
import type { ScheduleRequest, ScheduleEntry } from '../training/scheduler.js';
import { parameterizeWorkout } from '../training/parameterizer.js';
import type { ParameterizedWorkout } from '../training/parameterizer.js';
import { validatePlan } from '../training/validation.js';
import { getTemplate } from '../training/templates/index.js';
import {
  runChatTurn,
  ChatLlmNotConfiguredError,
  type ToolCall as ChatToolCall,
} from '../training/chat.js';
import {
  llmParameterizeWorkout,
  InvalidLlmWorkoutError,
} from '../training/llm-parameterizer.js';

export const trainingRouter = Router();

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const sportsSchema = z.object({
  running: z.boolean().default(false),
  cycling: z.boolean().default(false),
  swimming: z.boolean().default(false),
});

const planRequestSchema = z.object({
  weekStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  goal: z.string().max(500).optional(),
  raceDate: z.string().nullable().optional(),
  goalDistance: z.string().max(50).nullable().optional(),
  daysPerWeek: z.number().int().min(1).max(7),
  preferredRestDay: z.string().max(20).optional(),
  availableTime: z.string().max(200).optional(),
  injuries: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
  sports: sportsSchema,
  sportPriorities: z
    .array(
      z.enum(['running', 'cycling', 'swimming', 'rest', 'strength', 'mobility']),
    )
    .optional(),
  preferredKeyWorkoutDays: z.array(z.string()).optional(),
  maxHardSessionsPerWeek: z.number().int().min(0).max(7).nullable(),
  targetMetricPreference: z.enum(['auto', 'heart_rate', 'pace']),
});

const regenerateDaySchema = z.object({
  dayIndex: z.number().int().min(1).max(7),
  reason: z.string().max(500).optional(),
});

const workoutPatchSchema = z.object({
  status: z.enum(['planned', 'completed', 'skipped']),
});

const chatBodySchema = z.object({
  message: z.string().min(1).max(5000),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACTIVITY_LOOKBACK_DAYS = 56;
const DAY_MS = 24 * 60 * 60 * 1000;

interface DerivedContext {
  request: ScheduleRequest;
  athleteProfile: ReturnType<typeof buildAthleteProfile>;
  recentState: ReturnType<typeof deriveRecentTrainingState>;
  qualities: Map<string, QualityResult>;
  activities: NormalizedActivity[];
}

async function loadDerivedContext(
  userId: string,
  request: ScheduleRequest,
): Promise<DerivedContext> {
  const cutoff = new Date(Date.now() - ACTIVITY_LOOKBACK_DAYS * DAY_MS);

  const rows = await db
    .select()
    .from(activityCache)
    .where(eq(activityCache.userId, userId));

  const activities: NormalizedActivity[] = [];
  for (const row of rows) {
    const normalized = normalizeActivity(row.data);
    if (!normalized) continue;
    if (
      normalized.startTimeLocal &&
      normalized.startTimeLocal.getTime() < cutoff.getTime()
    ) {
      continue;
    }
    activities.push(normalized);
  }

  const qualities = new Map<string, QualityResult>();
  // First pass: rough cycling-median speed for the personal-baseline filter.
  const ridingSpeeds = activities
    .filter((a) => a.sport === 'cycling' && a.averageSpeed !== null)
    .map((a) => a.averageSpeed as number)
    .sort((a, b) => a - b);
  const cyclingMedianSpeedMps =
    ridingSpeeds.length > 0
      ? ridingSpeeds[Math.floor(ridingSpeeds.length / 2)]
      : null;
  for (const a of activities) {
    qualities.set(a.id, classifyActivityQuality(a, { cyclingMedianSpeedMps }));
  }

  const recentState = deriveRecentTrainingState({
    activities,
    qualities,
    asOf: new Date(),
  });
  const athleteProfile = buildAthleteProfile({
    activities,
    qualities,
    request: {
      injuries: request.injuries,
      raceDate: request.raceDate ?? null,
      goalDistance: request.goalDistance ?? null,
    },
  });

  return { request, athleteProfile, recentState, qualities, activities };
}

function toScheduleRequest(parsed: z.infer<typeof planRequestSchema>): ScheduleRequest {
  return {
    weekStartDate: parsed.weekStartDate,
    goal: parsed.goal,
    raceDate: parsed.raceDate ?? null,
    goalDistance: parsed.goalDistance ?? null,
    daysPerWeek: parsed.daysPerWeek,
    preferredRestDay: parsed.preferredRestDay,
    availableTime: parsed.availableTime,
    injuries: parsed.injuries,
    notes: parsed.notes,
    sports: parsed.sports,
    sportPriorities: parsed.sportPriorities,
    preferredKeyWorkoutDays: parsed.preferredKeyWorkoutDays,
    maxHardSessionsPerWeek: parsed.maxHardSessionsPerWeek,
    targetMetricPreference: parsed.targetMetricPreference,
  };
}

interface TrainingPlanSummary {
  id: string;
  weekStartDate: string;
  status: string;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

function toPlanSummary(row: TrainingPlan): TrainingPlanSummary {
  return {
    id: row.id,
    weekStartDate: String(row.weekStartDate),
    status: row.status,
    summary: row.summary,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

interface WorkoutInsertRow {
  id: string;
  planId: string;
  dayIndex: number;
  date: string;
  sport: string;
  templateId: string;
  workoutType: string;
  title: string;
  intensity: string;
  durationMinutes: number;
  distanceKm: string | null;
  targetMetric: string;
  targetHeartRate: string;
  targetPace: string;
  targetPower: string;
  workoutStructure: string;
  targets: string[];
  parameterSource: ParameterizedWorkout['parameterSource'];
  adaptation: string;
  status: 'planned' | 'completed' | 'skipped' | 'regenerating';
}

function buildWorkoutRow(
  planId: string,
  entry: ScheduleEntry,
  w: ParameterizedWorkout,
): WorkoutInsertRow {
  return {
    id: crypto.randomUUID(),
    planId,
    dayIndex: entry.dayIndex,
    date: entry.date,
    sport: entry.sport,
    templateId: w.templateId,
    workoutType: w.workoutType,
    title: w.title,
    intensity: w.intensity,
    durationMinutes: w.durationMinutes,
    distanceKm: w.distanceKm !== null ? w.distanceKm.toFixed(2) : null,
    targetMetric: w.targetMetric,
    targetHeartRate: w.targetHeartRate,
    targetPace: w.targetPace,
    targetPower: w.targetPower,
    workoutStructure: w.workoutStructure,
    targets: w.targets,
    parameterSource: w.parameterSource,
    adaptation: w.adaptation,
    status: 'planned',
  };
}

function chunkSummary(summary: string): string[] {
  if (!summary) return [];
  // Split by 句号 / period for a "streaming" feel even though we're deterministic.
  const parts = summary.split(/(?<=。)/).filter((s) => s.trim().length > 0);
  if (parts.length === 0) return [summary];
  // Group into 3-5 chunks max.
  const target = Math.min(5, Math.max(3, parts.length));
  const groupSize = Math.ceil(parts.length / target);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i += groupSize) {
    out.push(parts.slice(i, i + groupSize).join(''));
  }
  return out;
}

// ---------------------------------------------------------------------------
// POST /api/training/plans  — SSE
// ---------------------------------------------------------------------------

trainingRouter.post(
  '/plans',
  requireUser,
  requireProAndQuota('plan_generation'),
  async (req, res) => {
    const userId = (req as AuthedRequest).user.id;

    const parsed = planRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      res.status(400).json({
        error: 'invalid_input',
        field: first?.path.join('.') ?? null,
        reason: first?.message ?? 'invalid input',
      });
      return;
    }
    const request = toScheduleRequest(parsed.data);

    // Insert generating row first so we have an id to stream.
    const planId = crypto.randomUUID();
    const now = new Date();
    try {
      await db.insert(trainingPlan).values({
        id: planId,
        userId,
        weekStartDate: request.weekStartDate,
        status: 'generating',
        request: parsed.data,
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      console.error('[training] insert plan failed:', (err as Error).message);
      res.status(500).json({ error: 'internal_error' });
      return;
    }

    openSse(res);
    const heartbeat = startHeartbeat(res);
    writeEvent(res, 'plan_created', { planId });

    try {
      const ctx = await loadDerivedContext(userId, request);
      writeEvent(res, 'context', {
        recentState: {
          fatigue: ctx.recentState.fatigue,
          latestStimulus: ctx.recentState.latestStimulus,
          hardSessionsLast7d: ctx.recentState.hardSessionsLast7d,
          load7d: ctx.recentState.load7d,
          load28d: ctx.recentState.load28d,
          loadTrend: ctx.recentState.loadTrend,
          recommendation: ctx.recentState.recommendation,
        },
        athleteProfile: {
          experienceLevel: ctx.athleteProfile.experienceLevel,
          running: ctx.athleteProfile.running,
          cycling: ctx.athleteProfile.cycling,
          swimming: ctx.athleteProfile.swimming,
        },
      });

      // Buffer summary deltas streamed during generation; we forward them to
      // the SSE client AFTER the workouts/schedule events so the frontend
      // sees a stable order. They're still produced progressively as the LLM
      // streams, just held until we've emitted the schedule + workouts.
      const summaryDeltas: Array<{ kind: 'summary' | 'monitoring' | 'adjustment_rules'; text: string }> = [];

      const plan = await generatePlan({
        userId,
        request,
        athleteProfile: ctx.athleteProfile,
        recentState: ctx.recentState,
        onSummaryDelta: (delta) => {
          summaryDeltas.push(delta);
        },
      });

      writeEvent(res, 'schedule', { days: plan.schedule.days, notes: plan.schedule.notes });
      for (let i = 0; i < plan.workouts.length; i += 1) {
        const entry = plan.schedule.days[i];
        writeEvent(res, 'workout', {
          workout: plan.workouts[i],
          dayIndex: entry?.dayIndex ?? i + 1,
        });
      }
      if (plan.violations.length > 0) {
        writeEvent(res, 'violations', { violations: plan.violations });
      }

      // Persist all-or-nothing in a single transaction.
      const rows = plan.schedule.days.map((entry, i) =>
        buildWorkoutRow(planId, entry, plan.workouts[i]),
      );

      try {
        await db.transaction(async (tx) => {
          await tx.insert(workout).values(rows);
          await tx
            .update(trainingPlan)
            .set({
              status: 'ready',
              summary: plan.summary,
              monitoring: plan.monitoring,
              adjustmentRules: plan.adjustmentRules,
              athleteProfileSnapshot: {
                athleteProfile: ctx.athleteProfile,
                recentState: {
                  fatigue: ctx.recentState.fatigue,
                  latestStimulus: ctx.recentState.latestStimulus,
                  hardSessionsLast7d: ctx.recentState.hardSessionsLast7d,
                  load7d: ctx.recentState.load7d,
                  load28d: ctx.recentState.load28d,
                  loadTrend: ctx.recentState.loadTrend,
                  recommendation: ctx.recentState.recommendation,
                },
              },
              modelMeta: plan.modelMeta,
              updatedAt: new Date(),
            })
            .where(eq(trainingPlan.id, planId));
        });
      } catch (txErr) {
        console.error('[training] persist failed:', (txErr as Error).message);
        await markPlanFailed(planId, (txErr as Error).message);
        clearInterval(heartbeat);
        endSse(res, 'error', { error: 'persist_failed' });
        return;
      }

      // Replay the LLM-streamed deltas (or chunked deterministic fallback)
      // after persistence so the client sees a stable event order:
      // schedule -> workouts -> violations -> summary_delta* -> monitoring
      // -> adjustment_rules.
      if (summaryDeltas.length > 0) {
        for (const d of summaryDeltas) {
          if (d.kind === 'summary') {
            writeEvent(res, 'summary_delta', { delta: d.text });
          } else if (d.kind === 'monitoring') {
            writeEvent(res, 'summary_delta', { delta: d.text, kind: 'monitoring' });
          } else {
            writeEvent(res, 'summary_delta', { delta: d.text, kind: 'adjustment_rules' });
          }
        }
      } else {
        for (const chunk of chunkSummary(plan.summary)) {
          writeEvent(res, 'summary_delta', { delta: chunk });
        }
      }
      writeEvent(res, 'monitoring', { monitoring: plan.monitoring });
      writeEvent(res, 'adjustment_rules', { adjustmentRules: plan.adjustmentRules });

      // TODO(U11): consumeQuota(userId, 'plan_generation', { inputTokens, outputTokens })

      clearInterval(heartbeat);
      endSse(res, 'done', { planId });
    } catch (err) {
      console.error('[training] generate failed:', (err as Error).message);
      await markPlanFailed(planId, (err as Error).message);
      clearInterval(heartbeat);
      endSse(res, 'error', { error: 'generation_failed' });
    }
  },
);

async function markPlanFailed(planId: string, message: string): Promise<void> {
  try {
    await db
      .update(trainingPlan)
      .set({
        status: 'failed',
        modelMeta: { error: message.slice(0, 500) },
        updatedAt: new Date(),
      })
      .where(eq(trainingPlan.id, planId));
  } catch (err) {
    console.error('[training] markPlanFailed failed:', (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// GET /api/training/plans
// ---------------------------------------------------------------------------

trainingRouter.get('/plans', requireUser, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const rows = await db
    .select()
    .from(trainingPlan)
    .where(eq(trainingPlan.userId, userId))
    .orderBy(desc(trainingPlan.weekStartDate))
    .limit(20);
  res.json({ plans: rows.map(toPlanSummary) });
});

// ---------------------------------------------------------------------------
// GET /api/training/plans/:id
// ---------------------------------------------------------------------------

trainingRouter.get('/plans/:id', requireUser, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const planId = String(req.params.id);
  const planRow = await loadOwnedPlan(userId, planId);
  if (!planRow) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const workouts: Workout[] = await db
    .select()
    .from(workout)
    .where(eq(workout.planId, planId))
    .orderBy(asc(workout.dayIndex));
  const messages: ChatMessage[] = await db
    .select()
    .from(chatMessage)
    .where(eq(chatMessage.planId, planId))
    .orderBy(asc(chatMessage.createdAt))
    .limit(50);
  res.json({ plan: planRow, workouts, messages });
});

async function loadOwnedPlan(
  userId: string,
  planId: string,
): Promise<TrainingPlan | null> {
  const rows = await db
    .select()
    .from(trainingPlan)
    .where(and(eq(trainingPlan.id, planId), eq(trainingPlan.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// POST /api/training/plans/:id/regenerate-day  — SSE
// ---------------------------------------------------------------------------

trainingRouter.post(
  '/plans/:id/regenerate-day',
  requireUser,
  requireProAndQuota('plan_generation'),
  async (req, res) => {
    const userId = (req as AuthedRequest).user.id;
    const planId = String(req.params.id);

    const parsed = regenerateDaySchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      res.status(400).json({
        error: 'invalid_input',
        field: first?.path.join('.') ?? null,
        reason: first?.message ?? 'invalid input',
      });
      return;
    }

    const planRow = await loadOwnedPlan(userId, planId);
    if (!planRow) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const requestRaw = planRow.request as unknown;
    const requestParsed = planRequestSchema.safeParse(requestRaw);
    if (!requestParsed.success) {
      res.status(500).json({ error: 'plan_request_corrupt' });
      return;
    }
    const request = toScheduleRequest(requestParsed.data);

    openSse(res);
    const heartbeat = startHeartbeat(res);

    try {
      const ctx = await loadDerivedContext(userId, request);
      const schedule = buildWeeklySchedule({
        request,
        athleteProfile: ctx.athleteProfile,
        recentState: ctx.recentState,
      });

      const dayIndex = parsed.data.dayIndex;
      const entry = schedule.days[dayIndex - 1];
      if (!entry) {
        clearInterval(heartbeat);
        endSse(res, 'error', { error: 'day_not_found' });
        return;
      }

      const tpl = getTemplate(entry.templateId);
      const safeTpl = tpl ?? getTemplate('rest.full.v1')!;
      const progression =
        ctx.recentState.fatigue === 'tired' || ctx.recentState.fatigue === 'high_risk'
          ? 'conservative'
          : 'normal';

      const w = parameterizeWorkout({
        template: safeTpl,
        athleteProfile: ctx.athleteProfile,
        recentState: ctx.recentState,
        request: {
          targetMetricPreference: request.targetMetricPreference,
          availableTime: request.availableTime,
        },
        scheduleEntry: entry,
        progression,
      });

      // Build the existing workouts array for whole-week validation.
      const existing: Workout[] = await db
        .select()
        .from(workout)
        .where(eq(workout.planId, planId))
        .orderBy(asc(workout.dayIndex));

      const workoutsForValidation: ParameterizedWorkout[] = existing.map((row) =>
        row.dayIndex === dayIndex
          ? w
          : workoutRowToParameterized(row),
      );

      const violations = validatePlan({
        schedule: existing.map((row, i) =>
          row.dayIndex === dayIndex
            ? entry
            : {
                dayIndex: row.dayIndex,
                date: String(row.date),
                dayLabel: '周' + '一二三四五六日'[row.dayIndex - 1],
                sport: row.sport as ScheduleEntry['sport'],
                templateId: row.templateId,
              },
        ),
        workouts: workoutsForValidation,
        context: {
          maxHardSessionsPerWeek:
            request.maxHardSessionsPerWeek ?? 2,
          hardSessionsAlreadyDoneThisWeek: ctx.recentState.hardSessionsLast7d,
          latestStimulus: ctx.recentState.latestStimulus,
          hoursSinceLatest: ctx.recentState.latestReliableActivity?.startTimeLocal
            ? (Date.now() - ctx.recentState.latestReliableActivity.startTimeLocal.getTime()) /
              (60 * 60 * 1000)
            : Number.POSITIVE_INFINITY,
          fatigue: ctx.recentState.fatigue,
        },
      });

      const row = buildWorkoutRow(planId, entry, w);

      await db
        .update(workout)
        .set({
          sport: row.sport,
          templateId: row.templateId,
          workoutType: row.workoutType,
          title: row.title,
          intensity: row.intensity,
          durationMinutes: row.durationMinutes,
          distanceKm: row.distanceKm,
          targetMetric: row.targetMetric,
          targetHeartRate: row.targetHeartRate,
          targetPace: row.targetPace,
          targetPower: row.targetPower,
          workoutStructure: row.workoutStructure,
          targets: row.targets,
          parameterSource: row.parameterSource,
          adaptation: row.adaptation,
        })
        .where(and(eq(workout.planId, planId), eq(workout.dayIndex, dayIndex)));

      writeEvent(res, 'workout', { workout: w, dayIndex });
      if (violations.length > 0) {
        writeEvent(res, 'violations', { violations });
      }

      // TODO(U11): consumeQuota(userId, 'plan_generation', ...)

      clearInterval(heartbeat);
      endSse(res, 'done', { planId, dayIndex });
    } catch (err) {
      console.error('[training] regenerate-day failed:', (err as Error).message);
      clearInterval(heartbeat);
      endSse(res, 'error', { error: 'regeneration_failed' });
    }
  },
);

function workoutRowToParameterized(row: Workout): ParameterizedWorkout {
  return {
    templateId: row.templateId,
    sport: row.sport,
    workoutType: row.workoutType ?? '',
    title: row.title,
    intensity: row.intensity as 'low' | 'medium' | 'high',
    durationMinutes: row.durationMinutes ?? 0,
    distanceKm: row.distanceKm !== null ? Number(row.distanceKm) : null,
    targetMetric: (row.targetMetric ?? 'none') as ParameterizedWorkout['targetMetric'],
    targetHeartRate: row.targetHeartRate ?? '不适用',
    targetPace: row.targetPace ?? '不适用',
    targetPower: row.targetPower ?? '不适用',
    workoutStructure: row.workoutStructure ?? '',
    targets: row.targets ?? [],
    parameterSource: (row.parameterSource as ParameterizedWorkout['parameterSource']) ?? {
      templateId: row.templateId,
      progression: 'normal',
      replacedVariables: {},
    },
    adaptation: row.adaptation ?? '',
  };
}

// ---------------------------------------------------------------------------
// PATCH /api/training/workouts/:id
// ---------------------------------------------------------------------------

trainingRouter.patch('/workouts/:id', requireUser, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const workoutId = String(req.params.id);

  const parsed = workoutPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    res.status(400).json({
      error: 'invalid_input',
      field: first?.path.join('.') ?? null,
      reason: first?.message ?? 'invalid input',
    });
    return;
  }

  // Ownership check via join.
  const row = (
    await db
      .select({
        workout,
        plan: trainingPlan,
      })
      .from(workout)
      .innerJoin(trainingPlan, eq(workout.planId, trainingPlan.id))
      .where(and(eq(workout.id, workoutId), eq(trainingPlan.userId, userId)))
      .limit(1)
  )[0];
  if (!row) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const updated = (
    await db
      .update(workout)
      .set({ status: parsed.data.status })
      .where(eq(workout.id, workoutId))
      .returning()
  )[0];

  res.json({ workout: updated });
});

// ---------------------------------------------------------------------------
// GET /api/training/plans/:id/messages
// ---------------------------------------------------------------------------

trainingRouter.get('/plans/:id/messages', requireUser, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const planId = String(req.params.id);
  const planRow = await loadOwnedPlan(userId, planId);
  if (!planRow) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const messages: ChatMessage[] = await db
    .select()
    .from(chatMessage)
    .where(eq(chatMessage.planId, planId))
    .orderBy(asc(chatMessage.createdAt))
    .limit(200);
  res.json({ messages });
});

// ---------------------------------------------------------------------------
// POST /api/training/plans/:id/chat  — SSE
// ---------------------------------------------------------------------------

trainingRouter.post(
  '/plans/:id/chat',
  requireUser,
  requireProAndQuota('chat_message'),
  async (req, res) => {
    const userId = (req as AuthedRequest).user.id;
    const planId = String(req.params.id);

    const parsed = chatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      res.status(400).json({
        error: 'invalid_input',
        field: first?.path.join('.') ?? null,
        reason: first?.message ?? 'invalid input',
      });
      return;
    }
    const userMessageContent = parsed.data.message;

    const planRow = await loadOwnedPlan(userId, planId);
    if (!planRow) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const requestRaw = planRow.request as unknown;
    const requestParsed = planRequestSchema.safeParse(requestRaw);
    if (!requestParsed.success) {
      res.status(500).json({ error: 'plan_request_corrupt' });
      return;
    }
    const request = toScheduleRequest(requestParsed.data);

    openSse(res);
    const heartbeat = startHeartbeat(res);
    const abort = new AbortController();
    res.once('close', () => abort.abort());

    // Persist the user's message first so it survives even if the assistant
    // turn crashes mid-stream.
    const userMsgId = crypto.randomUUID();
    const userMsgCreatedAt = new Date();
    try {
      await db.insert(chatMessage).values({
        id: userMsgId,
        planId,
        userId,
        role: 'user',
        content: userMessageContent,
        toolCalls: null,
        toolResultRefs: null,
        createdAt: userMsgCreatedAt,
      });
    } catch (err) {
      console.error('[training/chat] insert user msg failed:', (err as Error).message);
      clearInterval(heartbeat);
      endSse(res, 'error', { error: 'persist_user_message_failed' });
      return;
    }

    writeEvent(res, 'user_message_saved', {
      message: {
        id: userMsgId,
        planId,
        userId,
        role: 'user',
        content: userMessageContent,
        toolCalls: null,
        toolResultRefs: null,
        createdAt: userMsgCreatedAt.toISOString(),
      },
    });

    try {
      const ctx = await loadDerivedContext(userId, request);

      // Load the latest snapshot of workouts (in case prior tool calls
      // mutated them). Use this list both for the LLM context and as a
      // working set for tool dispatch.
      let workoutsSnapshot: Workout[] = await db
        .select()
        .from(workout)
        .where(eq(workout.planId, planId))
        .orderBy(asc(workout.dayIndex));

      // History, oldest first, capped at 50 (NOT counting the just-inserted
      // user message — runChatTurn appends the user message itself).
      const historyAll: ChatMessage[] = await db
        .select()
        .from(chatMessage)
        .where(eq(chatMessage.planId, planId))
        .orderBy(asc(chatMessage.createdAt))
        .limit(200);
      const historyForTurn = historyAll
        .filter((m) => m.id !== userMsgId)
        .slice(-50);

      const toolResultRefs: Array<{
        workoutId: string;
        before: unknown;
        after: unknown;
      }> = [];

      const result = await runChatTurn({
        plan: planRow,
        workouts: workoutsSnapshot,
        history: historyForTurn,
        userMessage: userMessageContent,
        athleteProfile: ctx.athleteProfile,
        recentState: ctx.recentState,
        signal: abort.signal,
        onTextDelta: (text) => {
          writeEvent(res, 'text_delta', { text });
        },
        onToolCall: async (call) => {
          writeEvent(res, 'tool_call', {
            name: call.name,
            arguments: call.arguments,
          });
          const dispatched = await dispatchChatToolCall({
            call,
            planId,
            request,
            ctx,
            workoutsSnapshot,
            signal: abort.signal,
          });
          if (dispatched.updatedWorkout) {
            workoutsSnapshot = workoutsSnapshot.map((w) =>
              w.id === dispatched.updatedWorkout!.id ? dispatched.updatedWorkout! : w,
            );
            writeEvent(res, 'workout_updated', {
              workout: dispatched.updatedWorkout,
            });
          }
          if (dispatched.refEntry) {
            toolResultRefs.push(dispatched.refEntry);
          }
          return dispatched.toolResult;
        },
      });

      const assistantId = crypto.randomUUID();
      const assistantCreatedAt = new Date();
      const persistedToolCalls = result.toolCalls.map((tc) => ({
        name: tc.name,
        arguments: tc.arguments as unknown,
      }));
      const persistedToolResultRefs = toolResultRefs.length > 0 ? toolResultRefs : null;

      try {
        await db.insert(chatMessage).values({
          id: assistantId,
          planId,
          userId,
          role: 'assistant',
          content: result.assistantContent,
          toolCalls: persistedToolCalls.length > 0 ? persistedToolCalls : null,
          toolResultRefs: persistedToolResultRefs,
          createdAt: assistantCreatedAt,
        });
      } catch (err) {
        console.error(
          '[training/chat] insert assistant msg failed:',
          (err as Error).message,
        );
        clearInterval(heartbeat);
        endSse(res, 'error', { error: 'persist_assistant_message_failed' });
        return;
      }

      writeEvent(res, 'assistant_message_saved', {
        message: {
          id: assistantId,
          planId,
          userId,
          role: 'assistant',
          content: result.assistantContent,
          toolCalls: persistedToolCalls.length > 0 ? persistedToolCalls : null,
          toolResultRefs: persistedToolResultRefs,
          createdAt: assistantCreatedAt.toISOString(),
        },
      });

      // TODO(U11): consumeQuota(userId, 'chat_message',
      //   { inputTokens: result.meta.inputTokens, outputTokens: result.meta.outputTokens })

      clearInterval(heartbeat);
      endSse(res, 'done', {});
    } catch (err) {
      const code =
        err instanceof ChatLlmNotConfiguredError
          ? 'llm_not_configured'
          : 'chat_failed';
      console.error('[training/chat] failed:', (err as Error).message);
      clearInterval(heartbeat);
      endSse(res, 'error', { error: code });
    }
  },
);

// ---------------------------------------------------------------------------
// Tool dispatch (chat)
// ---------------------------------------------------------------------------

interface DispatchChatToolArgs {
  call: ChatToolCall;
  planId: string;
  request: ScheduleRequest;
  ctx: DerivedContext;
  workoutsSnapshot: Workout[];
  signal?: AbortSignal;
}

interface DispatchChatToolResult {
  toolResult: string;
  updatedWorkout?: Workout;
  refEntry?: { workoutId: string; before: unknown; after: unknown };
}

async function dispatchChatToolCall(
  args: DispatchChatToolArgs,
): Promise<DispatchChatToolResult> {
  const { call, planId, request, ctx, workoutsSnapshot, signal } = args;

  if (call.name === 'regenerate_day') {
    const dayIndex = call.arguments.dayIndex;
    const before = workoutsSnapshot.find((w) => w.dayIndex === dayIndex);
    if (!before) {
      return {
        toolResult: JSON.stringify({
          error: `day ${dayIndex} not found in current plan`,
        }),
      };
    }

    // Build a ScheduleEntry from the existing workout row so we can re-run
    // the parameterizer in place (without re-running the weekly scheduler).
    const entry: ScheduleEntry = {
      dayIndex: before.dayIndex,
      date: String(before.date),
      dayLabel: '周' + '一二三四五六日'[before.dayIndex - 1],
      sport: before.sport as ScheduleEntry['sport'],
      templateId: before.templateId,
    };

    const tpl = getTemplate(before.templateId) ?? getTemplate('rest.full.v1');
    if (!tpl) {
      return {
        toolResult: JSON.stringify({
          error: `template ${before.templateId} not found`,
        }),
      };
    }

    const progression =
      ctx.recentState.fatigue === 'tired' || ctx.recentState.fatigue === 'high_risk'
        ? 'conservative'
        : 'normal';

    let parameterized: ParameterizedWorkout;
    const isRest =
      tpl.fixed.sport === 'rest' || tpl.fixed.sport === 'mobility';
    if (isRest) {
      parameterized = parameterizeWorkout({
        template: tpl,
        athleteProfile: ctx.athleteProfile,
        recentState: ctx.recentState,
        request: {
          targetMetricPreference: request.targetMetricPreference,
          availableTime: request.availableTime,
        },
        scheduleEntry: entry,
        progression,
      });
    } else {
      try {
        const llmRes = await llmParameterizeWorkout({
          template: tpl,
          athleteProfile: ctx.athleteProfile,
          recentState: ctx.recentState,
          request: {
            targetMetricPreference: request.targetMetricPreference,
            availableTime: request.availableTime,
          },
          scheduleEntry: entry,
          progression,
          signal,
        });
        parameterized = {
          ...llmRes.workout,
          parameterSource: {
            ...llmRes.workout.parameterSource,
            replacedVariables: {
              ...llmRes.workout.parameterSource.replacedVariables,
              __source: 'llm-chat',
            },
          },
        };
      } catch (err) {
        if (err instanceof InvalidLlmWorkoutError) {
          console.error(
            `[training/chat] llm parameterize day ${dayIndex} invalid: ${err.violations.join('; ')}`,
          );
        } else {
          console.error(
            `[training/chat] llm parameterize day ${dayIndex} failed: ${(err as Error).message}`,
          );
        }
        parameterized = parameterizeWorkout({
          template: tpl,
          athleteProfile: ctx.athleteProfile,
          recentState: ctx.recentState,
          request: {
            targetMetricPreference: request.targetMetricPreference,
            availableTime: request.availableTime,
          },
          scheduleEntry: entry,
          progression,
        });
      }
    }

    const row = buildWorkoutRow(planId, entry, parameterized);
    const updated = (
      await db
        .update(workout)
        .set({
          sport: row.sport,
          templateId: row.templateId,
          workoutType: row.workoutType,
          title: row.title,
          intensity: row.intensity,
          durationMinutes: row.durationMinutes,
          distanceKm: row.distanceKm,
          targetMetric: row.targetMetric,
          targetHeartRate: row.targetHeartRate,
          targetPace: row.targetPace,
          targetPower: row.targetPower,
          workoutStructure: row.workoutStructure,
          targets: row.targets,
          parameterSource: row.parameterSource,
          adaptation: row.adaptation,
        })
        .where(and(eq(workout.planId, planId), eq(workout.dayIndex, dayIndex)))
        .returning()
    )[0];

    if (!updated) {
      return {
        toolResult: JSON.stringify({
          error: `failed to persist regenerated day ${dayIndex}`,
        }),
      };
    }

    return {
      toolResult: JSON.stringify({
        ok: true,
        dayIndex,
        workout: parameterized,
      }),
      updatedWorkout: updated,
      refEntry: { workoutId: updated.id, before, after: updated },
    };
  }

  if (call.name === 'update_workout_field') {
    const { workoutId, value } = call.arguments;
    const before = workoutsSnapshot.find((w) => w.id === workoutId);
    if (!before) {
      return {
        toolResult: JSON.stringify({
          error: `workout ${workoutId} not found in this plan`,
        }),
      };
    }
    const updated = (
      await db
        .update(workout)
        .set({ status: value })
        .where(and(eq(workout.id, workoutId), eq(workout.planId, planId)))
        .returning()
    )[0];
    if (!updated) {
      return {
        toolResult: JSON.stringify({
          error: `failed to update workout ${workoutId}`,
        }),
      };
    }
    return {
      toolResult: JSON.stringify({ ok: true, workoutId, status: value }),
      updatedWorkout: updated,
      refEntry: { workoutId, before, after: updated },
    };
  }

  return {
    toolResult: JSON.stringify({ error: 'unknown tool call' }),
  };
}
