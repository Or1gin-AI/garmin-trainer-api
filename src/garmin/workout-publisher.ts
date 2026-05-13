import crypto from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  garminPushedWorkout,
  trainingPlan,
  userCalendar,
  workout,
  type GarminPushedWorkout,
  type TrainingPlan,
  type Workout,
} from '../db/schema.js';
import { authenticate } from './client.js';
import type { Region } from './store.js';

type PublishRegion = Extract<Region, 'cn' | 'global'>;
type PushStatus = 'scheduled' | 'deleting' | 'deleted' | 'failed';

const DEFAULT_REGION: PublishRegion = 'cn';
const NAME_PREFIX = 'GT';
const SUPPORTED_SPORTS = new Set(['running', 'cycling', 'swimming']);
const GARMIN_PUBLISH_DAYS = 30;

interface GarminWorkoutPayload {
  workoutName: string;
  description: string;
  sportType: GarminSportType;
  estimatedDurationInSecs: number;
  estimatedDistanceInMeters: number | null;
  workoutSegments: Array<{
    segmentOrder: number;
    sportType: GarminSportType;
    workoutSteps: GarminWorkoutStep[];
  }>;
}

interface GarminSportType {
  sportTypeId: number;
  sportTypeKey: string;
  displayOrder: number;
}

interface GarminWorkoutStep {
  type: 'ExecutableStepDTO';
  stepOrder: number;
  stepType: {
    stepTypeId: number;
    stepTypeKey: string;
    displayOrder: number;
  };
  endCondition: {
    conditionTypeId: number;
    conditionTypeKey: string;
    displayOrder: number;
    displayable: boolean;
  };
  endConditionValue: number;
  targetType: {
    workoutTargetTypeId: number;
    workoutTargetTypeKey: string;
    displayOrder: number;
  };
  childStepId: null;
  endConditionCompare: null;
  endConditionZone: null;
  preferredEndConditionUnit: null | {
    unitKey: string;
  };
  targetValueOne: null;
  targetValueTwo: null;
  targetValueUnit: null;
  zoneNumber: null;
  strokeType: {
    strokeTypeId: number;
    displayOrder: number;
  };
  equipmentType: {
    equipmentTypeId: number;
    displayOrder: number;
  };
}

export interface GarminPushedWorkoutSummary {
  id: string;
  localWorkoutId: string;
  garminWorkoutId: string | null;
  garminScheduleId: string | null;
  scheduledDate: string;
  workoutName: string;
  status: PushStatus;
  lastError: string | null;
  updatedAt: string;
}

export interface GarminPlanPublishStatus {
  region: PublishRegion;
  uploaded: boolean;
  total: number;
  scheduled: number;
  deleting: number;
  deleted: number;
  failed: number;
  activeCount: number;
  lastUpdatedAt: string | null;
  workouts: GarminPushedWorkoutSummary[];
}

export interface GarminPlanPushResult {
  status: GarminPlanPublishStatus;
  pushed: number;
  skipped: number;
  failed: number;
  deletedBeforePush: number;
  blockedByCleanup: boolean;
  failures: Array<{ localWorkoutId: string; message: string }>;
}

export interface GarminPlanDeleteResult {
  status: GarminPlanPublishStatus;
  deleted: number;
  failed: number;
  failures: Array<{
    id: string;
    localWorkoutId: string;
    garminWorkoutId: string | null;
    garminScheduleId: string | null;
    message: string;
  }>;
}

function asPushStatus(value: string): PushStatus {
  if (
    value === 'scheduled' ||
    value === 'deleting' ||
    value === 'deleted' ||
    value === 'failed'
  ) {
    return value;
  }
  return 'failed';
}

function rowToSummary(row: GarminPushedWorkout): GarminPushedWorkoutSummary {
  return {
    id: row.id,
    localWorkoutId: row.localWorkoutId,
    garminWorkoutId: row.garminWorkoutId,
    garminScheduleId: row.garminScheduleId,
    scheduledDate: String(row.scheduledDate),
    workoutName: row.workoutName,
    status: asPushStatus(row.status),
    lastError: row.lastError,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function buildStatus(
  rows: GarminPushedWorkout[],
  region: PublishRegion,
): GarminPlanPublishStatus {
  const counts = {
    scheduled: 0,
    deleting: 0,
    deleted: 0,
    failed: 0,
  };
  let lastUpdatedAt: Date | null = null;
  for (const row of rows) {
    const status = asPushStatus(row.status);
    counts[status] += 1;
    if (!lastUpdatedAt || row.updatedAt > lastUpdatedAt) {
      lastUpdatedAt = row.updatedAt;
    }
  }
  const activeCount = counts.scheduled + counts.deleting + counts.failed;
  return {
    region,
    uploaded: activeCount > 0,
    total: rows.length,
    scheduled: counts.scheduled,
    deleting: counts.deleting,
    deleted: counts.deleted,
    failed: counts.failed,
    activeCount,
    lastUpdatedAt: lastUpdatedAt ? lastUpdatedAt.toISOString() : null,
    workouts: rows.map(rowToSummary),
  };
}

async function loadPublishRows(
  userId: string,
  planId: string,
  region: PublishRegion,
): Promise<GarminPushedWorkout[]> {
  return db
    .select()
    .from(garminPushedWorkout)
    .where(
      and(
        eq(garminPushedWorkout.userId, userId),
        eq(garminPushedWorkout.planId, planId),
        eq(garminPushedWorkout.region, region),
      ),
    )
    .orderBy(asc(garminPushedWorkout.scheduledDate), asc(garminPushedWorkout.id));
}

async function loadOwnedPlan(
  userId: string,
  planId: string,
): Promise<TrainingPlan | null> {
  const rows = await db
    .select()
    .from(trainingPlan)
    .where(and(eq(trainingPlan.userId, userId), eq(trainingPlan.id, planId)))
    .limit(1);
  return rows[0] ?? null;
}

async function loadOwnedPlanWorkouts(
  userId: string,
  planId: string,
): Promise<{ plan: TrainingPlan; workouts: Workout[] }> {
  const plan = await loadOwnedPlan(userId, planId);
  if (!plan) {
    throw new Error('training_plan_not_found');
  }
  if (plan.status !== 'ready') {
    throw new Error('training_plan_not_ready');
  }
  const rows = await db
    .select()
    .from(workout)
    .where(eq(workout.planId, planId))
    .orderBy(asc(workout.dayIndex), asc(workout.slotIndex));
  return { plan, workouts: rows };
}

export async function getPlanGarminStatus(
  userId: string,
  planId: string,
  region: PublishRegion = DEFAULT_REGION,
): Promise<GarminPlanPublishStatus> {
  const plan = await loadOwnedPlan(userId, planId);
  if (!plan) {
    throw new Error('training_plan_not_found');
  }
  return buildStatus(await loadPublishRows(userId, planId, region), region);
}

function sportTypeFor(sport: string): GarminSportType | null {
  if (sport === 'running') {
    return { sportTypeId: 1, sportTypeKey: 'running', displayOrder: 1 };
  }
  if (sport === 'cycling') {
    return { sportTypeId: 2, sportTypeKey: 'cycling', displayOrder: 2 };
  }
  if (sport === 'swimming') {
    return { sportTypeId: 4, sportTypeKey: 'swimming', displayOrder: 3 };
  }
  return null;
}

function clampName(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 80 ? normalized.slice(0, 77).trimEnd() + '...' : normalized;
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

function dayOffset(from: Date, to: Date): number {
  const a = new Date(from);
  const b = new Date(to);
  a.setHours(0, 0, 0, 0);
  b.setHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));
}

function circularDayIndex(planWeekStartDate: string, date: string): number {
  const offset = dayOffset(parseDateOnly(planWeekStartDate), parseDateOnly(date));
  return ((offset % 7) + 7) % 7 + 1;
}

function buildWorkoutName(plan: TrainingPlan, row: Workout, scheduledDate: string): string {
  const date = scheduledDate.slice(5);
  const slot = row.slotIndex && row.slotIndex > 1 ? `.${row.slotIndex}` : '';
  return clampName(`${NAME_PREFIX} ${date} D${row.dayIndex}${slot} ${row.title}`);
}

function describeWorkout(plan: TrainingPlan, row: Workout, scheduledDate: string): string {
  const lines = [
    'Garmin Trainer',
    `planId=${plan.id}`,
    `workoutId=${row.id}`,
    `date=${scheduledDate}`,
    '',
    row.title,
  ];
  if (row.sessionLabel) lines.push(`Session: ${row.sessionLabel}`);
  if (row.durationMinutes) lines.push(`Duration: ${row.durationMinutes} min`);
  if (row.distanceKm !== null) lines.push(`Distance: ${Number(row.distanceKm).toFixed(2)} km`);
  if (row.targetHeartRate && row.targetHeartRate !== '不适用') {
    lines.push(`HR: ${row.targetHeartRate}`);
  }
  if (row.targetPace && row.targetPace !== '不适用') {
    lines.push(`Pace: ${row.targetPace}`);
  }
  if (row.targetPower && row.targetPower !== '不适用') {
    lines.push(`Power: ${row.targetPower}`);
  }
  if (row.workoutStructure) {
    lines.push('', row.workoutStructure);
  }
  if (row.targets && row.targets.length > 0) {
    lines.push('', ...row.targets.map((target) => `- ${target}`));
  }
  return lines.join('\n').slice(0, 2000);
}

function buildNoTarget() {
  return {
    workoutTargetTypeId: 1,
    workoutTargetTypeKey: 'no.target',
    displayOrder: 1,
  };
}

function buildSingleStep(row: Workout): GarminWorkoutStep {
  const durationSeconds = Math.max(60, (row.durationMinutes ?? 30) * 60);
  return {
    type: 'ExecutableStepDTO',
    stepOrder: 1,
    childStepId: null,
    stepType: {
      stepTypeId: 3,
      stepTypeKey: 'interval',
      displayOrder: 3,
    },
    endCondition: {
      conditionTypeId: 2,
      conditionTypeKey: 'time',
      displayOrder: 2,
      displayable: true,
    },
    endConditionValue: durationSeconds,
    preferredEndConditionUnit: null,
    endConditionCompare: null,
    endConditionZone: null,
    targetType: buildNoTarget(),
    targetValueOne: null,
    targetValueTwo: null,
    targetValueUnit: null,
    zoneNumber: null,
    strokeType: {
      strokeTypeId: 0,
      displayOrder: 0,
    },
    equipmentType: {
      equipmentTypeId: 0,
      displayOrder: 0,
    },
  };
}

function toGarminWorkout(
  plan: TrainingPlan,
  row: Workout,
  scheduledDate: string,
): GarminWorkoutPayload | null {
  const sportType = sportTypeFor(row.sport);
  if (!sportType) return null;
  const durationSeconds = Math.max(60, (row.durationMinutes ?? 30) * 60);
  return {
    workoutName: buildWorkoutName(plan, row, scheduledDate),
    description: describeWorkout(plan, row, scheduledDate),
    sportType,
    estimatedDurationInSecs: durationSeconds,
    estimatedDistanceInMeters:
      row.distanceKm !== null ? Math.round(Number(row.distanceKm) * 1000) : null,
    workoutSegments: [
      {
        segmentOrder: 1,
        sportType,
        workoutSteps: [buildSingleStep(row)],
      },
    ],
  };
}

function payloadHash(payload: GarminWorkoutPayload): string {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function readPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, source);
}

function readId(source: unknown, paths: readonly string[]): string | null {
  for (const path of paths) {
    const value = readPath(source, path);
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function parseDateOnly(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function collectObjects(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  const obj = value as Record<string, unknown>;
  out.push(obj);
  for (const child of Object.values(obj)) {
    if (child && typeof child === 'object') collectObjects(child, out);
  }
  return out;
}

function sameCalendarDate(value: unknown, expected: string): boolean {
  return typeof value === 'string' && value.slice(0, 10) === expected;
}

async function findScheduledWorkoutId(
  client: any,
  garminWorkoutId: string,
  scheduledDate: string,
): Promise<string | null> {
  if (typeof client.getCalendar !== 'function') return null;
  const date = parseDateOnly(scheduledDate);
  const calendar = await client.getCalendar(date.getFullYear(), date.getMonth());
  for (const obj of collectObjects(calendar)) {
    const scheduleId =
      readId(obj, ['workoutScheduleId', 'scheduleId', 'id', 'scheduledWorkoutId']);
    if (!scheduleId) continue;
    const objWorkoutId = readId(obj, [
      'workoutId',
      'workout.workoutId',
      'workout.workoutId',
      'workoutDTO.workoutId',
    ]);
    const objDate =
      obj.calendarDate ?? obj.date ?? obj.scheduledDate ?? obj.startDate ?? obj.startTimeLocal;
    if (objWorkoutId === garminWorkoutId && sameCalendarDate(objDate, scheduledDate)) {
      return scheduleId;
    }
  }
  return null;
}

function isRemoteMissing(error: unknown): boolean {
  const e = error as {
    response?: { status?: number };
    status?: number;
    statusCode?: number;
    message?: string;
  };
  const status = e?.response?.status ?? e?.status ?? e?.statusCode;
  const message = String(e?.message ?? '');
  return status === 404 || message.includes('HTTP Error (404)');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function upsertPushRow(args: {
  userId: string;
  planId: string;
  row: Workout;
  region: PublishRegion;
  garminWorkoutId: string | null;
  garminScheduleId: string | null;
  scheduledDate: string;
  payload: GarminWorkoutPayload;
  status: PushStatus;
  lastError: string | null;
}): Promise<void> {
  const now = new Date();
  await db
    .insert(garminPushedWorkout)
    .values({
      id: crypto.randomUUID(),
      userId: args.userId,
      planId: args.planId,
      localWorkoutId: args.row.id,
      region: args.region,
      garminWorkoutId: args.garminWorkoutId,
      garminScheduleId: args.garminScheduleId,
      scheduledDate: args.scheduledDate,
      workoutName: args.payload.workoutName,
      payloadHash: payloadHash(args.payload),
      status: args.status,
      lastError: args.lastError,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        garminPushedWorkout.localWorkoutId,
        garminPushedWorkout.region,
        garminPushedWorkout.scheduledDate,
      ],
      set: {
        planId: args.planId,
        userId: args.userId,
        garminWorkoutId: args.garminWorkoutId,
        garminScheduleId: args.garminScheduleId,
        scheduledDate: args.scheduledDate,
        workoutName: args.payload.workoutName,
        payloadHash: payloadHash(args.payload),
        status: args.status,
        lastError: args.lastError,
        updatedAt: now,
      },
    });
}

function expandWorkoutsForPublish(
  plan: TrainingPlan,
  rows: Workout[],
): Array<{ row: Workout; scheduledDate: string }> {
  const byDay = new Map<number, Workout[]>();
  for (const row of rows) {
    const list = byDay.get(row.dayIndex) ?? [];
    list.push(row);
    byDay.set(row.dayIndex, list);
  }
  for (const list of byDay.values()) {
    list.sort((a, b) => (a.slotIndex ?? 1) - (b.slotIndex ?? 1));
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const items: Array<{ row: Workout; scheduledDate: string }> = [];
  for (let offset = 0; offset <= GARMIN_PUBLISH_DAYS; offset += 1) {
    const scheduledDate = localDateString(addDays(today, offset));
    const dayIndex = circularDayIndex(String(plan.weekStartDate), scheduledDate);
    for (const row of byDay.get(dayIndex) ?? []) {
      items.push({ row, scheduledDate });
    }
  }
  return items;
}

async function activatePlanInCalendar(userId: string, planId: string): Promise<void> {
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
}

async function unscheduleWorkout(client: any, scheduledWorkoutId: string): Promise<void> {
  const url = `${client.url.SCHEDULE_WORKOUTS}${scheduledWorkoutId}`;
  await client.client.delete(url);
}

async function deleteRemoteWorkout(client: any, garminWorkoutId: string): Promise<void> {
  if (typeof client.deleteWorkout === 'function') {
    await client.deleteWorkout({ workoutId: garminWorkoutId });
    return;
  }
  await client.client.delete(client.url.WORKOUT(garminWorkoutId));
}

export async function deletePlanFromGarmin(
  userId: string,
  planId: string,
  options: { region?: PublishRegion } = {},
): Promise<GarminPlanDeleteResult> {
  const region = options.region ?? DEFAULT_REGION;
  const plan = await loadOwnedPlan(userId, planId);
  if (!plan) {
    throw new Error('training_plan_not_found');
  }
  const rows = (await loadPublishRows(userId, planId, region)).filter(
    (row) => row.status !== 'deleted',
  );
  if (rows.length === 0) {
    return {
      status: buildStatus(await loadPublishRows(userId, planId, region), region),
      deleted: 0,
      failed: 0,
      failures: [],
    };
  }

  const { client } = await authenticate(userId, region);
  let deleted = 0;
  const failures: GarminPlanDeleteResult['failures'] = [];

  for (const row of rows) {
    await db
      .update(garminPushedWorkout)
      .set({ status: 'deleting', lastError: null, updatedAt: new Date() })
      .where(eq(garminPushedWorkout.id, row.id));

    try {
      let scheduleId = row.garminScheduleId;
      if (!scheduleId && row.garminWorkoutId) {
        scheduleId = await findScheduledWorkoutId(
          client,
          row.garminWorkoutId,
          String(row.scheduledDate),
        );
      }
      if (scheduleId) {
        try {
          await unscheduleWorkout(client, scheduleId);
        } catch (error) {
          if (!isRemoteMissing(error)) throw error;
        }
      }
      if (row.garminWorkoutId) {
        try {
          await deleteRemoteWorkout(client, row.garminWorkoutId);
        } catch (error) {
          if (!isRemoteMissing(error)) throw error;
        }
      }
      await db
        .update(garminPushedWorkout)
        .set({
          status: 'deleted',
          garminScheduleId: scheduleId ?? row.garminScheduleId,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(eq(garminPushedWorkout.id, row.id));
      deleted += 1;
    } catch (error) {
      const message = errorMessage(error);
      await db
        .update(garminPushedWorkout)
        .set({ status: 'failed', lastError: message, updatedAt: new Date() })
        .where(eq(garminPushedWorkout.id, row.id));
      failures.push({
        id: row.id,
        localWorkoutId: row.localWorkoutId,
        garminWorkoutId: row.garminWorkoutId,
        garminScheduleId: row.garminScheduleId,
        message,
      });
    }
  }

  return {
    status: buildStatus(await loadPublishRows(userId, planId, region), region),
    deleted,
    failed: failures.length,
    failures,
  };
}

export async function pushPlanToGarmin(
  userId: string,
  planId: string,
  options: { region?: PublishRegion } = {},
): Promise<GarminPlanPushResult> {
  const region = options.region ?? DEFAULT_REGION;
  const { plan, workouts } = await loadOwnedPlanWorkouts(userId, planId);

  const cleanup = await deletePlanFromGarmin(userId, planId, { region });
  if (cleanup.failed > 0) {
    return {
      status: cleanup.status,
      pushed: 0,
      skipped: 0,
      failed: cleanup.failed,
      deletedBeforePush: cleanup.deleted,
      blockedByCleanup: true,
      failures: cleanup.failures.map((failure) => ({
        localWorkoutId: failure.localWorkoutId,
        message: failure.message,
      })),
    };
  }

  const { client } = await authenticate(userId, region);
  const failures: GarminPlanPushResult['failures'] = [];
  let pushed = 0;
  let skipped = 0;
  const publishItems = expandWorkoutsForPublish(plan, workouts);

  for (const { row, scheduledDate } of publishItems) {
    if (!SUPPORTED_SPORTS.has(row.sport)) {
      skipped += 1;
      continue;
    }
    const payload = toGarminWorkout(plan, row, scheduledDate);
    if (!payload) {
      skipped += 1;
      continue;
    }

    let garminWorkoutId: string | null = null;
    let garminScheduleId: string | null = null;
    try {
      const created = await client.addWorkout(payload);
      garminWorkoutId = readId(created, ['workoutId', 'workout.workoutId', 'id']);
      if (!garminWorkoutId) {
        throw new Error('Garmin did not return workoutId after upload');
      }
      const scheduled = await client.scheduleWorkout(
        { workoutId: garminWorkoutId },
        parseDateOnly(scheduledDate),
      );
      garminScheduleId =
        readId(scheduled, [
          'workoutScheduleId',
          'scheduledWorkoutId',
          'scheduleId',
          'id',
        ]) ?? (await findScheduledWorkoutId(client, garminWorkoutId, scheduledDate));
      await upsertPushRow({
        userId,
        planId,
        row,
        region,
        garminWorkoutId,
        garminScheduleId,
        scheduledDate,
        payload,
        status: 'scheduled',
        lastError: null,
      });
      pushed += 1;
    } catch (error) {
      const message = errorMessage(error);
      await upsertPushRow({
        userId,
        planId,
        row,
        region,
        garminWorkoutId,
        garminScheduleId,
        scheduledDate,
        payload,
        status: 'failed',
        lastError: message,
      });
      failures.push({ localWorkoutId: row.id, message });
    }
  }

  if (pushed > 0) {
    await activatePlanInCalendar(userId, planId);
  }

  return {
    status: buildStatus(await loadPublishRows(userId, planId, region), region),
    pushed,
    skipped,
    failed: failures.length,
    deletedBeforePush: cleanup.deleted,
    blockedByCleanup: false,
    failures,
  };
}
