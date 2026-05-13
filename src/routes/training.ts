// Training plan routes (U7).
//
// Endpoints:
//   POST   /api/training/plans                           SSE; generate plan
//   GET    /api/training/plans                           list user's plans
//   GET    /api/training/plans/:id                       plan + workouts + chat
//   DELETE /api/training/plans/:id                       delete local plan
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
  activityCache,
  garminPushedWorkout,
  trainingPlan,
  workout,
  userCalendar,
  trainingEvaluation,
  chatMessage,
  type TrainingPlan,
  type Workout,
  type TrainingEvaluation,
  type ChatMessage,
} from '../db/schema.js';
import {
  fetchCalendarActivities,
  fetchRecentRawActivities,
  GarminUnavailableError,
} from '../garmin/fetch-recent.js';
import {
  deletePlanFromGarmin,
  getPlanGarminStatus,
  pushPlanToGarmin,
} from '../garmin/workout-publisher.js';
import { requireUser, type AuthedRequest } from '../lib/session.js';
import { requireProAndQuota, consumeQuota } from '../lib/quota.js';
import { openSse, writeEvent, endSse, startHeartbeat, emitToolEvent, type ToolEventPayload } from '../lib/sse.js';
import {
  TOOL_DISPLAY,
  summarizeAddSecondWorkout,
  summarizeRegenerateDay,
  summarizeUpdateStatus,
} from '../training/tool-event-labels.js';
import { normalizeActivity } from '../training/activity-normalizer.js';
import type { NormalizedActivity } from '../training/activity-normalizer.js';
import { classifyActivityQuality } from '../training/activity-quality.js';
import type { QualityResult } from '../training/activity-quality.js';
import { deriveRecentTrainingState } from '../training/recent-state.js';
import { buildAthleteProfile } from '../training/athlete-profile.js';
import { deriveTrainingCapacity } from '../training/training-capacity.js';
import { expandMultiSessionSchedule, generatePlan } from '../training/orchestrator.js';
import { buildWeeklySchedule, MAX_WEEKLY_TRAINING_MINUTES } from '../training/scheduler.js';
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
import { renderIntervalsIcu } from '../training/intervals-icu.js';

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
  preferredTrainingWindows: z.array(z.string().max(50)).max(7).optional(),
  dailyPreferredMinutes: z.number().int().min(15).max(MAX_WEEKLY_TRAINING_MINUTES).nullable().optional(),
  weeklyMaxMinutes: z.number().int().min(15).max(MAX_WEEKLY_TRAINING_MINUTES).nullable().optional(),
  expectedLoad: z.number().min(0).max(5000).nullable().optional(),
  allowAdvancedWorkouts: z.boolean().optional(),
  allowDoubleDays: z.boolean().optional(),
  forceRequestedSchedule: z.boolean().optional(),
  exportFormats: z.array(z.enum(['intervals_icu', 'word', 'pdf', 'excel'])).max(4).optional(),
  injuries: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
  sports: sportsSchema,
  sportPriorities: z
    .array(
      z.enum(['running', 'cycling', 'swimming', 'rest', 'strength', 'mobility']),
    )
    .optional(),
  preferredKeyWorkoutDays: z.array(z.string()).optional(),
  maxHardSessionsPerWeek: z.number().int().min(0).max(7).nullable().optional(),
  targetMetricPreference: z.enum(['auto', 'heart_rate', 'pace']),
});

const regenerateDaySchema = z.object({
  dayIndex: z.number().int().min(1).max(7),
  slotIndex: z.number().int().min(1).max(3).optional(),
  reason: z.string().max(500).optional(),
});

const workoutPatchSchema = z.object({
  status: z.enum(['planned', 'completed', 'skipped']),
});

const chatBodySchema = z.object({
  message: z.string().min(1).max(5000),
});

const calendarQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const garminRegionSchema = z.enum(['cn', 'global']).default('cn');

const trainingEvaluationSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  activityRefs: z
    .array(
      z.object({
        region: z.enum(['cn', 'global', 'manual']),
        activityId: z.union([z.string(), z.number()]).transform((value) => String(value)),
      }),
    )
    .min(1)
    .max(12),
  note: z.string().max(1000).optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACTIVITY_LOOKBACK_DAYS = 56;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TRAINING_PLANS_PER_USER = 10;

interface DerivedContext {
  request: ScheduleRequest;
  athleteProfile: ReturnType<typeof buildAthleteProfile>;
  recentState: ReturnType<typeof deriveRecentTrainingState>;
  trainingCapacity: ReturnType<typeof deriveTrainingCapacity>;
  qualities: Map<string, QualityResult>;
  activities: NormalizedActivity[];
}

async function loadDerivedContext(
  userId: string,
  request: ScheduleRequest,
  emit?: (e: ToolEventPayload) => void,
): Promise<DerivedContext> {
  const emitFn = emit ?? (() => {});
  const cutoff = new Date(Date.now() - ACTIVITY_LOOKBACK_DAYS * DAY_MS);

  const activitiesId = crypto.randomUUID();
  const activitiesStart = Date.now();
  emitFn({
    id: activitiesId,
    name: 'load_recent_activities',
    displayName: TOOL_DISPLAY.load_recent_activities,
    phase: 'start',
  });

  const fetched = await fetchRecentRawActivities(userId, {
    days: ACTIVITY_LOOKBACK_DAYS,
  });

  const activities: NormalizedActivity[] = [];
  for (const raw of fetched.activities) {
    const normalized = normalizeActivity(raw);
    if (!normalized) continue;
    if (
      normalized.startTimeLocal &&
      normalized.startTimeLocal.getTime() < cutoff.getTime()
    ) {
      continue;
    }
    activities.push(normalized);
  }

  emitFn({
    id: activitiesId,
    name: 'load_recent_activities',
    displayName: TOOL_DISPLAY.load_recent_activities,
    phase: 'done',
    summary: `已加载 ${activities.length} 条活动`,
    durationMs: Date.now() - activitiesStart,
  });

  const profileId = crypto.randomUUID();
  const profileStart = Date.now();
  emitFn({
    id: profileId,
    name: 'load_athlete_profile',
    displayName: TOOL_DISPLAY.load_athlete_profile,
    phase: 'start',
  });

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
  const runningPaces = activities
    .filter((a) => a.sport === 'running' && a.averagePaceSecPerKm !== null)
    .map((a) => a.averagePaceSecPerKm as number)
    .sort((a, b) => a - b);
  const runningMedianPaceSecPerKm =
    runningPaces.length > 0
      ? runningPaces[Math.floor(runningPaces.length / 2)]
      : null;
  const runningPowers = activities
    .filter((a) => a.sport === 'running' && a.averagePower !== null)
    .map((a) => a.averagePower as number)
    .sort((a, b) => a - b);
  const runningMedianPowerWatts =
    runningPowers.length > 0
      ? runningPowers[Math.floor(runningPowers.length / 2)]
      : null;
  for (const a of activities) {
    qualities.set(
      a.id,
      classifyActivityQuality(a, {
        cyclingMedianSpeedMps,
        runningMedianPaceSecPerKm,
        runningMedianPowerWatts,
      }),
    );
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
  const trainingCapacity = deriveTrainingCapacity({
    activities,
    qualities,
    asOf: new Date(),
  });

  emitFn({
    id: profileId,
    name: 'load_athlete_profile',
    displayName: TOOL_DISPLAY.load_athlete_profile,
    phase: 'done',
    summary: `${summarizeProfileShort(athleteProfile, recentState)} · 容量 ${trainingCapacity.overall.readiness}`,
    durationMs: Date.now() - profileStart,
  });

  return { request, athleteProfile, recentState, trainingCapacity, qualities, activities };
}

function summarizeProfileShort(
  profile: ReturnType<typeof buildAthleteProfile>,
  state: ReturnType<typeof deriveRecentTrainingState>,
): string {
  const fatigueZh: Record<string, string> = {
    fresh: '新鲜',
    normal: '正常',
    tired: '偏疲劳',
    high_risk: '高风险',
  };
  const exp = profile.experienceLevel ?? 'unknown';
  const expZh: Record<string, string> = {
    beginner: '入门',
    intermediate: '进阶',
    advanced: '资深',
    unknown: '未知',
  };
  return `${expZh[exp] ?? exp} · 疲劳：${fatigueZh[state.fatigue] ?? state.fatigue}`;
}

function toScheduleRequest(parsed: z.infer<typeof planRequestSchema>): ScheduleRequest {
  const forceRequestedSchedule =
    parsed.forceRequestedSchedule !== false || hasStrongScheduleOverrideIntent(parsed);
  return {
    weekStartDate: parsed.weekStartDate,
    goal: parsed.goal,
    raceDate: parsed.raceDate ?? null,
    goalDistance: parsed.goalDistance ?? null,
    daysPerWeek: parsed.daysPerWeek,
    preferredRestDay: parsed.preferredRestDay,
    availableTime: parsed.availableTime,
    preferredTrainingWindows: parsed.preferredTrainingWindows,
    dailyPreferredMinutes: parsed.dailyPreferredMinutes ?? null,
    weeklyMaxMinutes: parsed.weeklyMaxMinutes ?? MAX_WEEKLY_TRAINING_MINUTES,
    expectedLoad: parsed.expectedLoad ?? null,
    allowAdvancedWorkouts: parsed.allowAdvancedWorkouts,
    allowDoubleDays: parsed.allowDoubleDays,
    forceRequestedSchedule,
    exportFormats: parsed.exportFormats,
    injuries: parsed.injuries,
    notes: parsed.notes,
    sports: parsed.sports,
    sportPriorities: parsed.sportPriorities,
    preferredKeyWorkoutDays: parsed.preferredKeyWorkoutDays,
    maxHardSessionsPerWeek: parsed.maxHardSessionsPerWeek ?? null,
    targetMetricPreference: parsed.targetMetricPreference,
  };
}

function hasStrongScheduleOverrideIntent(parsed: z.infer<typeof planRequestSchema>): boolean {
  const text = [
    parsed.goal,
    parsed.notes,
    parsed.availableTime,
  ]
    .filter(Boolean)
    .join('\n');
  if (!text) return false;
  return /强烈要求|坚持生成|坚持按|强制生成|强制安排|无论如何|不要降级|不要保守|按我的要求|照我说的|force|override|insist/i.test(text);
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

async function countHeldTrainingPlans(userId: string): Promise<number> {
  const rows = await db
    .select({ id: trainingPlan.id })
    .from(trainingPlan)
    .where(eq(trainingPlan.userId, userId))
    .limit(MAX_TRAINING_PLANS_PER_USER + 1);
  return rows.length;
}

async function getBlockingGarminUploads(
  userId: string,
  planId: string,
): Promise<{
  activeCount: number;
  regions: Array<{ region: 'cn' | 'global'; activeCount: number }>;
}> {
  const rows = await db
    .select({
      region: garminPushedWorkout.region,
      status: garminPushedWorkout.status,
      garminWorkoutId: garminPushedWorkout.garminWorkoutId,
      garminScheduleId: garminPushedWorkout.garminScheduleId,
    })
    .from(garminPushedWorkout)
    .where(
      and(
        eq(garminPushedWorkout.userId, userId),
        eq(garminPushedWorkout.planId, planId),
      ),
    );

  const byRegion = new Map<'cn' | 'global', number>();
  for (const row of rows) {
    if (row.status === 'deleted') continue;
    const hasRemoteObject = Boolean(row.garminWorkoutId || row.garminScheduleId);
    if (!hasRemoteObject && row.status === 'failed') continue;
    const region = row.region === 'global' ? 'global' : 'cn';
    byRegion.set(region, (byRegion.get(region) ?? 0) + 1);
  }

  const regions = Array.from(byRegion.entries()).map(([region, activeCount]) => ({
    region,
    activeCount,
  }));
  return {
    activeCount: regions.reduce((sum, item) => sum + item.activeCount, 0),
    regions,
  };
}

interface WorkoutInsertRow {
  id: string;
  planId: string;
  dayIndex: number;
  slotIndex: number;
  date: string;
  sessionLabel: string | null;
  timeOfDay: 'morning' | 'midday' | 'afternoon' | 'evening' | null;
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

interface CalendarEvent {
  id: string;
  kind: 'planned_workout' | 'garmin_activity';
  date: string;
  startTimeLocal: string | null;
  title: string;
  sport: string;
  source: 'training_plan' | 'garmin';
  planId: string | null;
  workoutId: string | null;
  activityId: string | number | null;
  region: 'cn' | 'global' | 'manual' | null;
  status: string | null;
  slotIndex: number | null;
  sessionLabel: string | null;
  durationMinutes: number | null;
  distanceKm: number | null;
  intensity: string | null;
  targetMetric: string | null;
  targetHeartRate: string | null;
  targetPace: string | null;
  targetPower: string | null;
  workoutStructure: string | null;
  targets: string[] | null;
  metrics: Record<string, number | string | null>;
}

interface CalendarEvaluation {
  id: string;
  date: string;
  planId: string | null;
  plannedWorkoutIds: string[];
  activityRefs: Array<{ region: 'cn' | 'global' | 'manual'; activityId: string }>;
  status: string;
  result: {
    title: string;
    summary: string;
    plannedWorkoutCount: number;
    activityCount: number;
  } | null;
  note: string | null;
  createdAt: string;
}

interface CalendarActivitySourceStatus {
  region: 'cn' | 'global';
  count: number;
  error: string | null;
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
    slotIndex: entry.slotIndex ?? 1,
    date: entry.date,
    sessionLabel: entry.sessionLabel ?? null,
    timeOfDay: entry.timeOfDay ?? null,
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

function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(date: Date, days: number): Date {
  const out = new Date(date);
  out.setDate(out.getDate() + days);
  return out;
}

function parseDateOnly(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function daysBetweenInclusive(from: string, to: string): number {
  return Math.round((parseDateOnly(to).getTime() - parseDateOnly(from).getTime()) / DAY_MS) + 1;
}

function workoutToCalendarEvent(w: Workout, dateOverride?: string): CalendarEvent {
  const date = dateOverride ?? String(w.date);
  return {
    id: dateOverride ? `workout:${date}:${w.id}` : `workout:${w.id}`,
    kind: 'planned_workout',
    date,
    startTimeLocal: null,
    title: w.title,
    sport: w.sport,
    source: 'training_plan',
    planId: w.planId,
    workoutId: w.id,
    activityId: null,
    region: null,
    status: w.status,
    slotIndex: w.slotIndex ?? 1,
    sessionLabel: w.sessionLabel ?? null,
    durationMinutes: w.durationMinutes ?? null,
    distanceKm: w.distanceKm !== null ? Number(w.distanceKm) : null,
    intensity: w.intensity ?? null,
    targetMetric: w.targetMetric ?? null,
    targetHeartRate: w.targetHeartRate ?? null,
    targetPace: w.targetPace ?? null,
    targetPower: w.targetPower ?? null,
    workoutStructure: w.workoutStructure ?? null,
    targets: w.targets ?? null,
    metrics: {},
  };
}

function dayOffset(from: Date, to: Date): number {
  const a = new Date(from);
  const b = new Date(to);
  a.setHours(0, 0, 0, 0);
  b.setHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

function circularDayIndex(planWeekStartDate: string, date: string): number {
  const offset = dayOffset(parseDateOnly(planWeekStartDate), parseDateOnly(date));
  return ((offset % 7) + 7) % 7 + 1;
}

function expandPlanWorkoutsAcrossRange(
  planRow: TrainingPlan,
  rows: Workout[],
  from: string,
  to: string,
): CalendarEvent[] {
  const byDay = new Map<number, Workout[]>();
  for (const row of rows) {
    const list = byDay.get(row.dayIndex) ?? [];
    list.push(row);
    byDay.set(row.dayIndex, list);
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => (a.slotIndex ?? 1) - (b.slotIndex ?? 1));
  }

  const events: CalendarEvent[] = [];
  for (let cursor = parseDateOnly(from); cursor <= parseDateOnly(to); cursor = addDays(cursor, 1)) {
    const date = localDateString(cursor);
    const dayIndex = circularDayIndex(String(planRow.weekStartDate), date);
    for (const row of byDay.get(dayIndex) ?? []) {
      events.push(workoutToCalendarEvent(row, date));
    }
  }
  return events;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function readRawActivityName(raw: unknown): string | null {
  const obj = readObject(raw);
  const name = obj?.name ?? obj?.activityName;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

function activityToCalendarEvent(
  activity: NormalizedActivity,
  raw: unknown,
): CalendarEvent {
  const date = activity.startTimeLocal
    ? localDateString(activity.startTimeLocal)
    : localDateString(new Date());
  const title = readRawActivityName(raw) ?? activity.type;
  return {
    id: `activity:${activity.region}:${String(activity.activityId)}`,
    kind: 'garmin_activity',
    date,
    startTimeLocal: activity.startTimeLocal ? activity.startTimeLocal.toISOString() : null,
    title,
    sport: activity.sport,
    source: 'garmin',
    planId: null,
    workoutId: null,
    activityId: activity.activityId,
    region: activity.region,
    status: null,
    slotIndex: null,
    sessionLabel: null,
    durationMinutes: Math.round(activity.durationMin),
    distanceKm: activity.distanceKm,
    intensity: null,
    targetMetric: null,
    targetHeartRate: null,
    targetPace: null,
    targetPower: null,
    workoutStructure: null,
    targets: null,
    metrics: {
      averageHr: activity.averageHr,
      maxHr: activity.maxHr,
      trainingLoad: activity.trainingLoad,
      aerobicTrainingEffect: activity.aerobicTrainingEffect,
      anaerobicTrainingEffect: activity.anaerobicTrainingEffect,
      averagePower: activity.averagePower,
      averagePaceSecPerKm: activity.averagePaceSecPerKm,
      averagePaceSecPer100m: activity.averagePaceSecPer100m,
    },
  };
}

async function loadActivityEvents(
  userId: string,
  from: string,
  to: string,
): Promise<{
  events: CalendarEvent[];
  sources: CalendarActivitySourceStatus[];
}> {
  const byActivity = new Map<string, { activity: NormalizedActivity; raw: unknown }>();
  const rows = await db
    .select()
    .from(activityCache)
    .where(eq(activityCache.userId, userId));

  for (const row of rows) {
    const raw = readObject(row.data)
      ? { ...(row.data as Record<string, unknown>), region: row.region, activityId: row.activityId }
      : row.data;
    const activity = normalizeActivity(raw);
    if (!activity?.startTimeLocal) continue;
    const date = localDateString(activity.startTimeLocal);
    if (date < from || date > to) continue;
    byActivity.set(`${activity.region}:${String(activity.activityId)}`, { activity, raw });
  }

  const live = await fetchCalendarActivities(userId, {
    days: Math.max(daysBetweenInclusive(from, to) + 2, 62),
    limit: 160,
  });
  for (const raw of live.activities) {
    const activity = normalizeActivity(raw);
    if (!activity?.startTimeLocal) continue;
    const date = localDateString(activity.startTimeLocal);
    if (date < from || date > to) continue;
    byActivity.set(`${activity.region}:${String(activity.activityId)}`, { activity, raw });
  }

  return {
    events: Array.from(byActivity.values()).map(({ activity, raw }) =>
      activityToCalendarEvent(activity, raw),
    ),
    sources: [
      { region: 'cn', count: live.cn.count, error: live.cn.error },
      { region: 'global', count: live.global.count, error: live.global.error },
    ],
  };
}

function buildEvaluationPlaceholder(
  plannedWorkoutIds: string[],
  activityRefs: Array<{ region: 'cn' | 'global' | 'manual'; activityId: string }>,
) {
  return {
    title: '训练评价已生成',
    summary: '已记录这一天的实际运动，并与当天训练计划建立对比关系。详细评价模型稍后接入。',
    plannedWorkoutCount: plannedWorkoutIds.length,
    activityCount: activityRefs.length,
  };
}

function evaluationToSummary(row: TrainingEvaluation): CalendarEvaluation {
  const plannedWorkoutIds = row.plannedWorkoutIds ?? [];
  const activityRefs = row.activityRefs ?? [];
  const result =
    row.result && typeof row.result === 'object'
      ? (row.result as CalendarEvaluation['result'])
      : buildEvaluationPlaceholder(plannedWorkoutIds, activityRefs);
  return {
    id: row.id,
    date: String(row.evaluationDate),
    planId: row.planId,
    plannedWorkoutIds,
    activityRefs,
    status: row.status === 'pending' ? 'ready' : row.status,
    result,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}

async function loadCalendarEvaluations(
  userId: string,
  from: string,
  to: string,
): Promise<CalendarEvaluation[]> {
  const rows = await db
    .select()
    .from(trainingEvaluation)
    .where(eq(trainingEvaluation.userId, userId))
    .orderBy(desc(trainingEvaluation.createdAt));
  return rows
    .filter((row) => {
      const date = String(row.evaluationDate);
      return date >= from && date <= to;
    })
    .map(evaluationToSummary);
}

function planWorkoutsForDate(
  planRow: TrainingPlan,
  rows: Workout[],
  date: string,
): Workout[] {
  const dayIndex = circularDayIndex(String(planRow.weekStartDate), date);
  return rows
    .filter((row) => row.dayIndex === dayIndex)
    .sort((a, b) => (a.slotIndex ?? 1) - (b.slotIndex ?? 1));
}

async function loadActiveCalendarPlan(
  userId: string,
): Promise<{ plan: TrainingPlan; workouts: Workout[] } | null> {
  const cal = (
    await db
      .select()
      .from(userCalendar)
      .where(eq(userCalendar.userId, userId))
      .limit(1)
  )[0] ?? null;
  if (!cal?.activePlanId) return null;

  const planRow = await loadOwnedPlan(userId, cal.activePlanId);
  if (!planRow) return null;
  const rows: Workout[] = await db
    .select()
    .from(workout)
    .where(eq(workout.planId, planRow.id))
    .orderBy(asc(workout.dayIndex), asc(workout.slotIndex));
  return { plan: planRow, workouts: rows };
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

    const heldCount = await countHeldTrainingPlans(userId);
    if (heldCount >= MAX_TRAINING_PLANS_PER_USER) {
      res.status(409).json({
        error: 'training_plan_limit_reached',
        limit: MAX_TRAINING_PLANS_PER_USER,
        count: heldCount,
      });
      return;
    }

    // Insert generating row first so we have an id to stream.
    const planId = crypto.randomUUID();
    const now = new Date();
    try {
      await db.insert(trainingPlan).values({
        id: planId,
        userId,
        weekStartDate: request.weekStartDate,
        status: 'generating',
        request: {
          ...parsed.data,
          forceRequestedSchedule: request.forceRequestedSchedule === true,
          weeklyMaxMinutes: request.weeklyMaxMinutes ?? MAX_WEEKLY_TRAINING_MINUTES,
        },
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

    const emitToolEv = (e: ToolEventPayload) => emitToolEvent(res, e);

    try {
      const ctx = await loadDerivedContext(userId, request, emitToolEv);
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
        trainingCapacity: {
          overall: ctx.trainingCapacity.overall,
          load: ctx.trainingCapacity.load,
          recovery: ctx.trainingCapacity.recovery,
          guardrails: ctx.trainingCapacity.guardrails,
        },
        forceRequestedSchedule: request.forceRequestedSchedule === true,
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
        trainingCapacity: ctx.trainingCapacity,
        onSummaryDelta: (delta) => {
          summaryDeltas.push(delta);
        },
        onToolEvent: emitToolEv,
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
                trainingCapacity: {
                  overall: ctx.trainingCapacity.overall,
                  load: ctx.trainingCapacity.load,
                  recovery: ctx.trainingCapacity.recovery,
                  guardrails: ctx.trainingCapacity.guardrails,
                },
                scheduleNotes: plan.schedule.notes,
                forceRequestedSchedule: request.forceRequestedSchedule === true,
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

      // U11: consume quota only after persistence + all events succeeded.
      // We sum total tokens into inputTokens because the orchestrator only
      // exposes totalTokens; outputTokens stays 0 to keep the column shape
      // honest. Failures must NOT increment, so this stays inside the try
      // block, after the persistence transaction succeeded.
      try {
        await consumeQuota(userId, 'plan_generation', {
          inputTokens: plan.modelMeta.totalTokens || 0,
          outputTokens: 0,
        });
      } catch (qErr) {
        console.error(
          '[training] consumeQuota plan_generation failed:',
          (qErr as Error).message,
        );
      }

      clearInterval(heartbeat);
      endSse(res, 'done', { planId });
    } catch (err) {
      console.error('[training] generate failed:', (err as Error).message);
      await markPlanFailed(planId, (err as Error).message);
      clearInterval(heartbeat);
      const errorPayload =
        err instanceof GarminUnavailableError
          ? { error: (err as Error).message }
          : { error: 'generation_failed' };
      endSse(res, 'error', errorPayload);
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

trainingRouter.delete('/plans/:id', requireUser, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const planId = String(req.params.id);
  const planRow = await loadOwnedPlan(userId, planId);
  if (!planRow) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const blocking = await getBlockingGarminUploads(userId, planId);
  if (blocking.activeCount > 0) {
    res.status(409).json({
      error: 'garmin_plan_uploaded',
      activeCount: blocking.activeCount,
      regions: blocking.regions,
    });
    return;
  }

  await db
    .delete(trainingPlan)
    .where(and(eq(trainingPlan.id, planId), eq(trainingPlan.userId, userId)));
  res.json({ deletedPlanId: planId });
});

// ---------------------------------------------------------------------------
// GET /api/training/calendar
// ---------------------------------------------------------------------------

trainingRouter.get('/calendar', requireUser, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const parsed = calendarQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    res.status(400).json({
      error: 'invalid_input',
      field: first?.path.join('.') ?? null,
      reason: first?.message ?? 'invalid input',
    });
    return;
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const from = parsed.data.from ?? localDateString(addDays(today, -30));
  const to = parsed.data.to ?? localDateString(addDays(today, 30));
  if (from > to || daysBetweenInclusive(from, to) > 120) {
    res.status(400).json({ error: 'invalid_date_range' });
    return;
  }

  const events: CalendarEvent[] = [];
  let activePlan: TrainingPlanSummary | null = null;

  const active = await loadActiveCalendarPlan(userId);
  if (active) {
    activePlan = toPlanSummary(active.plan);
    events.push(...expandPlanWorkoutsAcrossRange(active.plan, active.workouts, from, to));
  }
  const activityLoad = await loadActivityEvents(userId, from, to);
  events.push(...activityLoad.events);

  events.sort((a, b) => {
    const dateCmp = a.date.localeCompare(b.date);
    if (dateCmp !== 0) return dateCmp;
    const sourceCmp = a.kind.localeCompare(b.kind);
    if (sourceCmp !== 0) return sourceCmp;
    return (a.slotIndex ?? 99) - (b.slotIndex ?? 99);
  });
  const evaluations = await loadCalendarEvaluations(userId, from, to);

  res.json({
    calendar: {
      activePlan,
      activePlanId: activePlan?.id ?? null,
      from,
      to,
      activitySources: activityLoad.sources,
    },
    events,
    evaluations,
  });
});

trainingRouter.post('/calendar/evaluations', requireUser, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const parsed = trainingEvaluationSchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    res.status(400).json({
      error: 'invalid_input',
      field: first?.path.join('.') ?? null,
      reason: first?.message ?? 'invalid input',
    });
    return;
  }

  const active = await loadActiveCalendarPlan(userId);
  if (!active) {
    res.status(409).json({ error: 'no_active_training_plan' });
    return;
  }

  const activityLoad = await loadActivityEvents(userId, parsed.data.date, parsed.data.date);
  const available = new Set(
    activityLoad.events.map((event) => `${event.region}:${String(event.activityId)}`),
  );
  const requested = parsed.data.activityRefs.map((ref) => ({
    region: ref.region,
    activityId: ref.activityId,
  }));
  const invalid = requested.filter(
    (ref) => !available.has(`${ref.region}:${ref.activityId}`),
  );
  if (invalid.length > 0) {
    res.status(400).json({ error: 'invalid_activity_selection' });
    return;
  }

  const plannedWorkoutIds = planWorkoutsForDate(
    active.plan,
    active.workouts,
    parsed.data.date,
  ).map((row) => row.id);
  const result = buildEvaluationPlaceholder(plannedWorkoutIds, requested);
  const now = new Date();
  const row = (
    await db
      .insert(trainingEvaluation)
      .values({
        id: crypto.randomUUID(),
        userId,
        planId: active.plan.id,
        evaluationDate: parsed.data.date,
        plannedWorkoutIds,
        activityRefs: requested,
        status: 'ready',
        result,
        note: parsed.data.note ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
  )[0];

  res.json({ evaluation: evaluationToSummary(row) });
});

trainingRouter.delete('/calendar/active-plan', requireUser, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  await db
    .insert(userCalendar)
    .values({
      userId,
      activePlanId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: userCalendar.userId,
      set: { activePlanId: null, updatedAt: new Date() },
    });
  res.json({ activePlanId: null });
});

trainingRouter.post('/plans/:id/import-calendar', requireUser, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const planId = String(req.params.id);
  const planRow = await loadOwnedPlan(userId, planId);
  if (!planRow) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (planRow.status !== 'ready') {
    res.status(409).json({ error: 'plan_not_ready' });
    return;
  }

  await db
    .insert(userCalendar)
    .values({
      userId,
      activePlanId: planId,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: userCalendar.userId,
      set: { activePlanId: planId, updatedAt: new Date() },
    });

  res.json({ activePlanId: planId, activePlan: toPlanSummary(planRow) });
});

trainingRouter.get('/plans/:id/garmin', requireUser, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const planId = String(req.params.id);
  const region = garminRegionSchema.safeParse(req.query.region ?? 'cn');
  if (!region.success) {
    res.status(400).json({ error: 'invalid_region' });
    return;
  }
  try {
    const status = await getPlanGarminStatus(userId, planId, region.data);
    res.json({ status });
  } catch (error) {
    if ((error as Error).message === 'training_plan_not_found') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    console.error('[training] garmin status failed:', (error as Error).message);
    res.status(500).json({ error: (error as Error).message });
  }
});

trainingRouter.post('/plans/:id/garmin', requireUser, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const planId = String(req.params.id);
  const region = garminRegionSchema.safeParse(req.body?.region ?? req.query.region ?? 'cn');
  if (!region.success) {
    res.status(400).json({ error: 'invalid_region' });
    return;
  }
  try {
    const result = await pushPlanToGarmin(userId, planId, { region: region.data });
    res.json(result);
  } catch (error) {
    const message = (error as Error).message;
    if (message === 'training_plan_not_found') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (message === 'training_plan_not_ready') {
      res.status(409).json({ error: 'plan_not_ready' });
      return;
    }
    console.error('[training] garmin push failed:', message);
    res.status(500).json({ error: message });
  }
});

trainingRouter.delete('/plans/:id/garmin', requireUser, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const planId = String(req.params.id);
  const region = garminRegionSchema.safeParse(req.query.region ?? 'cn');
  if (!region.success) {
    res.status(400).json({ error: 'invalid_region' });
    return;
  }
  try {
    const result = await deletePlanFromGarmin(userId, planId, { region: region.data });
    res.json(result);
  } catch (error) {
    const message = (error as Error).message;
    if (message === 'training_plan_not_found') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    console.error('[training] garmin delete failed:', message);
    res.status(500).json({ error: message });
  }
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
    .orderBy(asc(workout.dayIndex), asc(workout.slotIndex));
  const messages: ChatMessage[] = await db
    .select()
    .from(chatMessage)
    .where(eq(chatMessage.planId, planId))
    .orderBy(asc(chatMessage.createdAt))
    .limit(50);
  res.json({ plan: planRow, workouts, messages });
});

trainingRouter.get('/plans/:id/export/:format', requireUser, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const planId = String(req.params.id);
  const format = String(req.params.format);
  if (!['intervals_icu', 'word', 'pdf', 'excel'].includes(format)) {
    res.status(400).json({ error: 'unsupported_format' });
    return;
  }
  const planRow = await loadOwnedPlan(userId, planId);
  if (!planRow) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  const workouts: Workout[] = await db
    .select()
    .from(workout)
    .where(eq(workout.planId, planId))
    .orderBy(asc(workout.dayIndex), asc(workout.slotIndex));

  const stem = `training-plan-${String(planRow.weekStartDate)}`;
  if (format === 'intervals_icu') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${stem}-intervals-icu.txt"`);
    res.send(renderIntervalsIcu(workouts));
    return;
  }
  if (format === 'excel') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${stem}.csv"`);
    res.send(renderCsv(workouts));
    return;
  }
  if (format === 'word') {
    res.setHeader('Content-Type', 'application/msword; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${stem}.doc"`);
    res.send(renderWordHtml(planRow, workouts));
    return;
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${stem}.pdf"`);
  res.send(renderSimplePdf(renderPlainTextPlan(planRow, workouts)));
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

function renderPlainTextPlan(planRow: TrainingPlan, workouts: Workout[]): string {
  const lines = [`Garmin Trainer Plan ${String(planRow.weekStartDate)}`, ''];
  for (const w of workouts) {
    const session = w.sessionLabel ? ` ${w.sessionLabel}` : '';
    lines.push(`D${w.dayIndex}${session} ${w.title}`);
    lines.push(`Sport: ${w.sport}  Duration: ${w.durationMinutes ?? ''}min  Distance: ${w.distanceKm ?? ''}km`);
    if (w.targetHeartRate && w.targetHeartRate !== '不适用') lines.push(`HR: ${w.targetHeartRate}`);
    if (w.targetPace && w.targetPace !== '不适用') lines.push(`Pace: ${w.targetPace}`);
    if (w.targetPower && w.targetPower !== '不适用') lines.push(`Power: ${w.targetPower}`);
    if (w.workoutStructure) lines.push(w.workoutStructure);
    lines.push('');
  }
  return lines.join('\n');
}

function renderCsv(workouts: Workout[]): string {
  const header = [
    'date',
    'dayIndex',
    'slotIndex',
    'session',
    'sport',
    'title',
    'durationMinutes',
    'distanceKm',
    'targetMetric',
    'targetHeartRate',
    'targetPace',
    'targetPower',
    'structure',
  ];
  const rows = workouts.map((w) => [
    String(w.date),
    String(w.dayIndex),
    String(w.slotIndex ?? 1),
    w.sessionLabel ?? '',
    w.sport,
    w.title,
    String(w.durationMinutes ?? ''),
    String(w.distanceKm ?? ''),
    w.targetMetric,
    w.targetHeartRate ?? '',
    w.targetPace ?? '',
    w.targetPower ?? '',
    w.workoutStructure ?? '',
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function renderWordHtml(planRow: TrainingPlan, workouts: Workout[]): string {
  const rows = workouts
    .map(
      (w) => `<tr><td>${escapeHtml(String(w.date))}</td><td>${w.dayIndex}.${w.slotIndex ?? 1}</td><td>${escapeHtml(w.sessionLabel ?? '')}</td><td>${escapeHtml(w.sport)}</td><td>${escapeHtml(w.title)}</td><td>${escapeHtml(w.targetHeartRate ?? '')}</td><td>${escapeHtml(w.targetPace ?? '')}</td><td>${escapeHtml(w.targetPower ?? '')}</td><td>${escapeHtml(w.workoutStructure ?? '')}</td></tr>`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial,"Microsoft YaHei",sans-serif}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:6px;font-size:12px}th{background:#eee}</style></head><body><h1>训练计划 ${escapeHtml(String(planRow.weekStartDate))}</h1><table><thead><tr><th>日期</th><th>课次</th><th>时段</th><th>项目</th><th>训练</th><th>心率</th><th>配速</th><th>功率</th><th>结构</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderSimplePdf(text: string): Buffer {
  const safeLines = text
    .split('\n')
    .slice(0, 80)
    .map((line) => line.slice(0, 95));
  const content = ['BT', '/F1 10 Tf', '50 780 Td'];
  safeLines.forEach((line, i) => {
    if (i > 0) content.push('0 -14 Td');
    content.push(`<${toUtf16BeHex(line)}> Tj`);
  });
  content.push('ET');
  const stream = content.join('\n');
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj',
    '4 0 obj << /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >> endobj',
    `5 0 obj << /Length ${Buffer.byteLength(stream, 'ascii')} >> stream\n${stream}\nendstream endobj`,
    '6 0 obj << /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /FontDescriptor 7 0 R >> endobj',
    '7 0 obj << /Type /FontDescriptor /FontName /STSong-Light /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >> endobj',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += obj + '\n';
  }
  const xref = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

function toUtf16BeHex(value: string): string {
  const le = Buffer.from(value, 'utf16le');
  const be = Buffer.alloc(le.length);
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1];
    be[i + 1] = le[i];
  }
  return be.toString('hex').toUpperCase();
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

    const emitToolEv = (e: ToolEventPayload) => emitToolEvent(res, e);

    try {
      const ctx = await loadDerivedContext(userId, request, emitToolEv);
      let schedule = buildWeeklySchedule({
        request,
        athleteProfile: ctx.athleteProfile,
        recentState: ctx.recentState,
        trainingCapacity: ctx.trainingCapacity,
      });
      schedule = expandMultiSessionSchedule(
        schedule,
        request,
        ctx.athleteProfile,
        ctx.recentState,
        ctx.trainingCapacity,
      );

      const dayIndex = parsed.data.dayIndex;
      const slotIndex = parsed.data.slotIndex ?? 1;
      const existing: Workout[] = await db
        .select()
        .from(workout)
        .where(eq(workout.planId, planId))
        .orderBy(asc(workout.dayIndex), asc(workout.slotIndex));
      const before = existing.find(
        (row) => row.dayIndex === dayIndex && (row.slotIndex ?? 1) === slotIndex,
      );
      if (!before) {
        clearInterval(heartbeat);
        endSse(res, 'error', { error: 'workout_slot_not_found' });
        return;
      }
      const entry = schedule.days.find((d) => d.dayIndex === dayIndex && (d.slotIndex ?? 1) === slotIndex) ??
        workoutRowToScheduleEntry(before);
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

      const paramId = crypto.randomUUID();
      const paramStart = Date.now();
      emitToolEv({
        id: paramId,
        name: 'llm_parameterize_workout',
        displayName: `第 ${dayIndex} 天 · 重新生成参数`,
        phase: 'start',
      });
      const w = parameterizeWorkout({
        template: safeTpl,
        athleteProfile: ctx.athleteProfile,
        recentState: ctx.recentState,
        request: {
          targetMetricPreference: request.targetMetricPreference,
          availableTime: request.availableTime,
          dailyPreferredMinutes: request.dailyPreferredMinutes,
        },
        scheduleEntry: entry,
        progression,
      });
      emitToolEv({
        id: paramId,
        name: 'llm_parameterize_workout',
        displayName: `第 ${dayIndex} 天 · 重新生成参数`,
        phase: 'done',
        summary: w.title || '已生成',
        durationMs: Date.now() - paramStart,
      });

      // Build the existing workouts array for whole-week validation.
      const workoutsForValidation: ParameterizedWorkout[] = existing.map((row) =>
        row.dayIndex === dayIndex
          && (row.slotIndex ?? 1) === slotIndex
          ? w
          : workoutRowToParameterized(row),
      );

      const validateId = crypto.randomUUID();
      const validateStart = Date.now();
      emitToolEv({
        id: validateId,
        name: 'validate_plan',
        displayName: TOOL_DISPLAY.validate_plan,
        phase: 'start',
      });
      const violations = validatePlan({
        schedule: existing.map((row, i) =>
          row.dayIndex === dayIndex
            && (row.slotIndex ?? 1) === slotIndex
            ? entry
            : {
                dayIndex: row.dayIndex,
                date: String(row.date),
                dayLabel: '周' + '一二三四五六日'[row.dayIndex - 1],
                sport: row.sport as ScheduleEntry['sport'],
                templateId: row.templateId,
                slotIndex: row.slotIndex ?? 1,
                sessionLabel: row.sessionLabel ?? undefined,
                timeOfDay: (row.timeOfDay as ScheduleEntry['timeOfDay']) ?? undefined,
              },
        ),
        workouts: workoutsForValidation,
        context: {
          maxHardSessionsPerWeek:
            ctx.trainingCapacity &&
            request.forceRequestedSchedule !== true &&
            request.maxHardSessionsPerWeek === null
              ? Math.min(
                  request.maxHardSessionsPerWeek ?? 2,
                  ctx.trainingCapacity.guardrails.maxHardSessionsPerWeek,
                )
              : request.maxHardSessionsPerWeek ?? 2,
          hardSessionsAlreadyDoneThisWeek: ctx.recentState.hardSessionsLast7d,
          latestStimulus: ctx.recentState.latestStimulus,
          hoursSinceLatest: ctx.recentState.latestReliableActivity?.startTimeLocal
            ? (Date.now() - ctx.recentState.latestReliableActivity.startTimeLocal.getTime()) /
              (60 * 60 * 1000)
            : Number.POSITIVE_INFINITY,
          fatigue: ctx.recentState.fatigue,
          forceRequestedSchedule: request.forceRequestedSchedule === true,
          weeklyMaxMinutes: request.weeklyMaxMinutes ?? MAX_WEEKLY_TRAINING_MINUTES,
          trainingCapacity: request.forceRequestedSchedule === true ? undefined : ctx.trainingCapacity,
        },
      });
      emitToolEv({
        id: validateId,
        name: 'validate_plan',
        displayName: TOOL_DISPLAY.validate_plan,
        phase: 'done',
        summary: violations.length === 0 ? '无冲突' : `检出 ${violations.length} 处冲突`,
        durationMs: Date.now() - validateStart,
      });

      const row = buildWorkoutRow(planId, entry, w);

      await db
        .update(workout)
        .set({
          sport: row.sport,
          sessionLabel: row.sessionLabel,
          timeOfDay: row.timeOfDay,
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
        .where(and(eq(workout.id, before.id), eq(workout.planId, planId)));

      writeEvent(res, 'workout', { workout: w, dayIndex, slotIndex });
      if (violations.length > 0) {
        writeEvent(res, 'violations', { violations });
      }

      // U11: consume quota after the per-day regeneration successfully
      // persisted. The deterministic regenerate-day path doesn't track LLM
      // tokens, so we record 0/0 for input/output — the counter still bumps.
      try {
        await consumeQuota(userId, 'plan_generation', {
          inputTokens: 0,
          outputTokens: 0,
        });
      } catch (qErr) {
        console.error(
          '[training] consumeQuota regenerate-day failed:',
          (qErr as Error).message,
        );
      }

      clearInterval(heartbeat);
      endSse(res, 'done', { planId, dayIndex, slotIndex });
    } catch (err) {
      console.error('[training] regenerate-day failed:', (err as Error).message);
      clearInterval(heartbeat);
      const errorPayload =
        err instanceof GarminUnavailableError
          ? { error: (err as Error).message }
          : { error: 'regeneration_failed' };
      endSse(res, 'error', errorPayload);
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

function workoutRowToScheduleEntry(row: Workout): ScheduleEntry {
  return {
    dayIndex: row.dayIndex,
    date: String(row.date),
    dayLabel: '周' + '一二三四五六日'[row.dayIndex - 1],
    sport: row.sport as ScheduleEntry['sport'],
    templateId: row.templateId,
    slotIndex: row.slotIndex ?? 1,
    sessionLabel: row.sessionLabel ?? undefined,
    timeOfDay: (row.timeOfDay as ScheduleEntry['timeOfDay']) ?? undefined,
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

    const emitToolEv = (e: ToolEventPayload) => emitToolEvent(res, e);

    try {
      const ctx = await loadDerivedContext(userId, request, emitToolEv);

      // Load the latest snapshot of workouts (in case prior tool calls
      // mutated them). Use this list both for the LLM context and as a
      // working set for tool dispatch.
      let workoutsSnapshot: Workout[] = await db
        .select()
        .from(workout)
        .where(eq(workout.planId, planId))
        .orderBy(asc(workout.dayIndex), asc(workout.slotIndex));

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
          const toolEventId = crypto.randomUUID();
          const toolEventStart = Date.now();
          const displayName = TOOL_DISPLAY[call.name] ?? call.name;
          emitToolEv({
            id: toolEventId,
            name: call.name,
            displayName,
            phase: 'start',
          });
          let dispatched: Awaited<ReturnType<typeof dispatchChatToolCall>>;
          try {
            dispatched = await dispatchChatToolCall({
              call,
              planId,
              request,
              ctx,
              workoutsSnapshot,
              signal: abort.signal,
            });
          } catch (err) {
            emitToolEv({
              id: toolEventId,
              name: call.name,
              displayName,
              phase: 'error',
              errorMessage: (err as Error).message || '工具执行失败',
              durationMs: Date.now() - toolEventStart,
            });
            throw err;
          }
          if (dispatched.updatedWorkout) {
            const existed = workoutsSnapshot.some((w) => w.id === dispatched.updatedWorkout!.id);
            workoutsSnapshot = (existed
              ? workoutsSnapshot.map((w) =>
                  w.id === dispatched.updatedWorkout!.id ? dispatched.updatedWorkout! : w,
                )
              : [...workoutsSnapshot, dispatched.updatedWorkout]
            ).sort((a, b) => a.dayIndex - b.dayIndex || (a.slotIndex ?? 1) - (b.slotIndex ?? 1));
            writeEvent(res, 'workout_updated', {
              workout: dispatched.updatedWorkout,
            });
          }
          if (dispatched.refEntry) {
            toolResultRefs.push(dispatched.refEntry);
          }
          let summary: string | undefined;
          if (call.name === 'regenerate_day') {
            const w = dispatched.updatedWorkout;
            if (w) {
              summary = summarizeRegenerateDay(call.arguments.dayIndex, w.sport as string);
            } else {
              summary = `第 ${call.arguments.dayIndex} 天处理完成`;
            }
          } else if (call.name === 'add_second_workout') {
            const w = dispatched.updatedWorkout;
            if (w) {
              summary = summarizeAddSecondWorkout(call.arguments.dayIndex, w.sport as string);
            } else {
              summary = `第 ${call.arguments.dayIndex} 天加练处理完成`;
            }
          } else if (call.name === 'update_workout_field') {
            summary = summarizeUpdateStatus(call.arguments.value);
          }
          emitToolEv({
            id: toolEventId,
            name: call.name,
            displayName,
            phase: 'done',
            summary,
            durationMs: Date.now() - toolEventStart,
          });
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

      // U11: consume quota only after assistant message persisted.
      // Failed turns (LLM errors, persist errors) MUST NOT increment.
      try {
        await consumeQuota(userId, 'chat_message', {
          inputTokens: result.meta.inputTokens,
          outputTokens: result.meta.outputTokens,
        });
      } catch (qErr) {
        console.error(
          '[training] consumeQuota chat_message failed:',
          (qErr as Error).message,
        );
      }

      clearInterval(heartbeat);
      endSse(res, 'done', {});
    } catch (err) {
      console.error('[training/chat] failed:', (err as Error).message);
      clearInterval(heartbeat);
      let errorPayload: { error: string };
      if (err instanceof ChatLlmNotConfiguredError) {
        errorPayload = { error: 'llm_not_configured' };
      } else if (err instanceof GarminUnavailableError) {
        errorPayload = { error: (err as Error).message };
      } else {
        errorPayload = { error: 'chat_failed' };
      }
      endSse(res, 'error', errorPayload);
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
    const explicitWorkoutId = call.arguments.workoutId;
    const explicitSlotIndex = call.arguments.slotIndex;
    const candidates = workoutsSnapshot.filter((w) => w.dayIndex === dayIndex);
    const before = explicitWorkoutId
      ? candidates.find((w) => w.id === explicitWorkoutId)
      : explicitSlotIndex !== undefined
        ? candidates.find((w) => (w.slotIndex ?? 1) === explicitSlotIndex)
        : candidates.length === 1
          ? candidates[0]
          : undefined;
    if (!before) {
      if (candidates.length > 1 && explicitWorkoutId === undefined && explicitSlotIndex === undefined) {
        return {
          toolResult: JSON.stringify({
            error: `day ${dayIndex} has multiple workouts; specify slotIndex or workoutId`,
            candidates: candidates.map((w) => ({
              workoutId: w.id,
              slotIndex: w.slotIndex ?? 1,
              sessionLabel: w.sessionLabel,
              title: w.title,
            })),
          }),
        };
      }
      return {
        toolResult: JSON.stringify({
          error: explicitWorkoutId
            ? `workout ${explicitWorkoutId} not found on day ${dayIndex}`
            : `day ${dayIndex} slot ${explicitSlotIndex ?? 1} not found in current plan`,
        }),
      };
    }

    // Build a ScheduleEntry from the existing workout row so we can re-run
    // the parameterizer in place (without re-running the weekly scheduler).
    const entry = workoutRowToScheduleEntry(before);

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
          dailyPreferredMinutes: request.dailyPreferredMinutes,
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
            dailyPreferredMinutes: request.dailyPreferredMinutes,
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
            dailyPreferredMinutes: request.dailyPreferredMinutes,
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
          sessionLabel: row.sessionLabel,
          timeOfDay: row.timeOfDay,
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
        .where(and(eq(workout.id, before.id), eq(workout.planId, planId)))
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
        slotIndex: before.slotIndex ?? 1,
        workout: parameterized,
      }),
      updatedWorkout: updated,
      refEntry: { workoutId: updated.id, before, after: updated },
    };
  }

  if (call.name === 'add_second_workout') {
    const dayIndex = call.arguments.dayIndex;
    const candidates = workoutsSnapshot
      .filter((w) => w.dayIndex === dayIndex)
      .sort((a, b) => (a.slotIndex ?? 1) - (b.slotIndex ?? 1));
    if (candidates.length === 0) {
      return {
        toolResult: JSON.stringify({
          error: `day ${dayIndex} not found in current plan`,
        }),
      };
    }

    const usedSlots = new Set(candidates.map((w) => w.slotIndex ?? 1));
    const slotIndex = [2, 3].find((slot) => !usedSlots.has(slot));
    if (!slotIndex) {
      return {
        toolResult: JSON.stringify({
          error: `day ${dayIndex} already has maximum workout slots`,
          candidates: candidates.map((w) => ({
            workoutId: w.id,
            slotIndex: w.slotIndex ?? 1,
            sessionLabel: w.sessionLabel,
            title: w.title,
          })),
        }),
      };
    }

    const templateId = chooseSecondWorkoutTemplate({
      requestedSport: call.arguments.sport,
      requestedTemplateId: call.arguments.templateId,
      dayWorkouts: candidates,
      athleteProfile: ctx.athleteProfile,
    });
    const tpl = getTemplate(templateId);
    if (!tpl) {
      return {
        toolResult: JSON.stringify({
          error: `template ${templateId} not found`,
        }),
      };
    }

    const entry: ScheduleEntry = {
      dayIndex,
      date: String(candidates[0].date),
      dayLabel: '周' + '一二三四五六日'[dayIndex - 1],
      sport: tpl.fixed.sport,
      templateId,
      slotIndex,
      sessionLabel: slotIndex === 2 ? '下午' : '加练',
      timeOfDay: slotIndex === 2 ? 'afternoon' : 'evening',
      reason: call.arguments.reason,
      durationCapMinutes: secondWorkoutDurationCap(templateId),
      durationCapReason: '聊天加练：第二课时默认控制为短低压力训练。',
    };

    const progression =
      ctx.recentState.fatigue === 'tired' || ctx.recentState.fatigue === 'high_risk'
        ? 'conservative'
        : 'normal';
    const parameterized = parameterizeWorkout({
      template: tpl,
      athleteProfile: ctx.athleteProfile,
      recentState: ctx.recentState,
      request: {
        targetMetricPreference: request.targetMetricPreference,
        availableTime: request.availableTime,
        dailyPreferredMinutes: null,
      },
      scheduleEntry: entry,
      progression,
    });

    const row = buildWorkoutRow(planId, entry, parameterized);
    const inserted = (
      await db
        .insert(workout)
        .values(row)
        .returning()
    )[0];

    if (!inserted) {
      return {
        toolResult: JSON.stringify({
          error: `failed to persist second workout for day ${dayIndex}`,
        }),
      };
    }

    return {
      toolResult: JSON.stringify({
        ok: true,
        dayIndex,
        slotIndex,
        workout: parameterized,
      }),
      updatedWorkout: inserted,
      refEntry: { workoutId: inserted.id, before: null, after: inserted },
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

function chooseSecondWorkoutTemplate(args: {
  requestedSport?: 'running' | 'cycling' | 'swimming' | 'mobility';
  requestedTemplateId?: string;
  dayWorkouts: Workout[];
  athleteProfile: ReturnType<typeof buildAthleteProfile>;
}): string {
  if (args.requestedTemplateId) {
    return args.requestedTemplateId;
  }

  const bySport: Record<'running' | 'cycling' | 'swimming' | 'mobility', string> = {
    running: 'run.recovery.v1',
    cycling: 'bike.recovery_spin.v1',
    swimming: 'swim.recovery.v1',
    mobility: 'rest.mobility.v1',
  };
  if (args.requestedSport) {
    return bySport[args.requestedSport];
  }

  const existingSports = new Set(args.dayWorkouts.map((w) => w.sport));
  const profile = args.athleteProfile;

  // Default product behavior: second sessions should be low-pressure and
  // preferably cross-training. This handles "你自己决定" without asking the
  // model to invent a slot or pick a hard workout.
  if (profile.swimming.available && !existingSports.has('swimming')) {
    return 'swim.recovery.v1';
  }
  if (profile.cycling.available && !existingSports.has('cycling')) {
    return 'bike.recovery_spin.v1';
  }
  if (profile.running.available && !existingSports.has('running')) {
    return 'run.recovery.v1';
  }
  if (profile.swimming.available) return 'swim.recovery.v1';
  if (profile.cycling.available) return 'bike.recovery_spin.v1';
  if (profile.running.available) return 'run.recovery.v1';
  return 'rest.mobility.v1';
}

function secondWorkoutDurationCap(templateId: string): number {
  if (templateId === 'rest.mobility.v1') return 20;
  if (templateId === 'rest.walk.v1') return 30;
  if (templateId.startsWith('swim.')) return 40;
  if (templateId.startsWith('bike.')) return 45;
  if (templateId.startsWith('run.')) return 35;
  return 40;
}
