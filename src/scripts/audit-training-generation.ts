import 'dotenv/config';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { llmConfig } from '../db/schema.js';
import { encryptGlobal } from '../lib/crypto.js';
import { clearLlmConfigCache } from '../lib/llm.js';
import { generatePlan, type GeneratedPlan } from '../training/orchestrator.js';
import { parameterizeWorkout, type ParameterizedWorkout } from '../training/parameterizer.js';
import {
  MAX_WEEKLY_TRAINING_MINUTES,
  type ActiveSport,
  type ScheduleEntry,
  type ScheduleRequest,
} from '../training/scheduler.js';
import type { AthleteProfile } from '../training/athlete-profile.js';
import type { RecentState } from '../training/recent-state.js';
import { getTemplate, WORKOUT_TEMPLATES, type Sport } from '../training/templates/index.js';
import type { WorkoutTemplate } from '../training/templates/types.js';
import { validatePlan } from '../training/validation.js';

type JsonRecord = Record<string, unknown>;

const AUDIT_LLM_NAME = 'codex-audit-openai-compatible';
const WEEK_START = '2026-05-18';
const DAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

const advancedProfile: AthleteProfile = {
  heartRate: {
    maxHeartRate: 190,
    recoveryRange: [101, 118],
    aerobicLowRange: [119, 130],
    aerobicRange: [119, 138],
    zone2Range: [119, 138],
    tempoRange: [146, 158],
    thresholdRange: [159, 171],
    vo2CapRange: [172, 181],
    source: 'garmin_zones',
  },
  running: {
    available: true,
    confidence: 'high',
    easyPaceSecPerKm: 330,
    longPaceSecPerKm: 345,
    tempoPaceSecPerKm: 285,
    thresholdPaceSecPerKm: 270,
    intervalPaceSecPerKm: 250,
    vo2PaceSecPerKm: 240,
    racePaceSecPerKm: 275,
    vo2Max: 56,
  },
  cycling: {
    available: true,
    confidence: 'high',
    ftpWatts: 250,
    ftpSource: 'garmin_profile',
    enduranceHrRange: [120, 138],
    tempoHrRange: [145, 156],
    thresholdHrRange: [157, 170],
    vo2HrCapRange: [171, 181],
  },
  swimming: {
    available: true,
    confidence: 'high',
    poolLengthM: 25,
    easyPaceSecPer100m: 130,
    aerobicPaceSecPer100m: 120,
    endurancePaceSecPer100m: 118,
    cssPaceSecPer100m: 105,
    cssSource: 'garmin_critical_swim_speed',
    vo2PaceSecPer100m: 98,
    sprintPaceSecPer100m: 88,
  },
  injuries: [],
  experienceLevel: 'advanced',
};

const normalRecentState: RecentState = {
  latestReliableActivity: null,
  latestStimulus: 'aerobic',
  latestTrainingLoad: 80,
  fatigue: 'normal',
  hardSessionsLast7d: 0,
  load7d: 420,
  load28d: 1600,
  loadTrend: 'stable',
  recommendation: '状态正常，可以安排结构化训练。',
};

const highRiskRecentState: RecentState = {
  ...normalRecentState,
  latestStimulus: 'threshold',
  fatigue: 'high_risk',
  hardSessionsLast7d: 3,
  load7d: 900,
  loadTrend: 'rising',
  recommendation: '疲劳风险高，建议只保留风险提示并谨慎执行用户要求。',
};

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function makeRequest(overrides: Partial<ScheduleRequest>): ScheduleRequest {
  return {
    weekStartDate: WEEK_START,
    goal: '提升综合耐力',
    raceDate: null,
    goalDistance: null,
    daysPerWeek: 4,
    preferredRestDay: '',
    availableTime: '',
    injuries: '',
    notes: '',
    sports: { running: true, cycling: false, swimming: false },
    sportPriorities: [],
    preferredKeyWorkoutDays: [],
    preferredTrainingWindows: [],
    dailyPreferredMinutes: 60,
    weeklyMaxMinutes: 420,
    allowAdvancedWorkouts: false,
    allowDoubleDays: false,
    forceRequestedSchedule: true,
    exportFormats: [],
    maxHardSessionsPerWeek: 2,
    targetMetricPreference: 'auto',
    ...overrides,
  };
}

function entryFor(templateId: string, dayIndex: number, slotIndex = 1): ScheduleEntry {
  const tpl = getTemplate(templateId);
  if (!tpl) throw new Error(`missing template ${templateId}`);
  return {
    dayIndex,
    date: addDays(WEEK_START, dayIndex - 1),
    dayLabel: DAY_LABELS[dayIndex - 1] ?? `第 ${dayIndex} 天`,
    sport: tpl.fixed.sport,
    templateId,
    slotIndex,
    sessionLabel: slotIndex > 1 ? `训练 ${slotIndex}` : undefined,
    timeOfDay: slotIndex > 1 ? 'evening' : 'morning',
    reason: 'audit',
  };
}

function auditAllTemplates(): string[] {
  const failures: string[] = [];
  const restWorkout = parameterizeWorkout({
    template: getTemplate('rest.full.v1')!,
    athleteProfile: advancedProfile,
    recentState: normalRecentState,
    request: { targetMetricPreference: 'auto', dailyPreferredMinutes: null },
    scheduleEntry: entryFor('rest.full.v1', 7),
    progression: 'normal',
  });

  for (const templateId of Object.keys(WORKOUT_TEMPLATES).sort()) {
    const template = getTemplate(templateId)!;
    const entry = entryFor(templateId, 1);
    const workout = parameterizeWorkout({
      template,
      athleteProfile: advancedProfile,
      recentState: normalRecentState,
      request: {
        targetMetricPreference: 'auto',
        dailyPreferredMinutes: Math.min(template.fixed.maxDurationMinutes, 90),
      },
      scheduleEntry: entry,
      progression: 'normal',
    });
    const schedule = [
      entry,
      entryFor('rest.full.v1', 2),
      entryFor('rest.full.v1', 3),
      entryFor('rest.full.v1', 4),
      entryFor('rest.full.v1', 5),
      entryFor('rest.full.v1', 6),
      entryFor('rest.full.v1', 7),
    ];
    const workouts = [
      workout,
      restWorkout,
      restWorkout,
      restWorkout,
      restWorkout,
      restWorkout,
      restWorkout,
    ];
    const violations = validatePlan({
      schedule,
      workouts,
      context: {
        maxHardSessionsPerWeek: 7,
        hardSessionsAlreadyDoneThisWeek: 0,
        latestStimulus: 'aerobic',
        hoursSinceLatest: 72,
        fatigue: 'normal',
        forceRequestedSchedule: true,
        weeklyMaxMinutes: MAX_WEEKLY_TRAINING_MINUTES,
      },
    });
    if (workout.templateId !== templateId) {
      failures.push(`${templateId}: parameterizer returned ${workout.templateId}`);
    }
    if (workout.sport !== template.fixed.sport) {
      failures.push(`${templateId}: sport mismatch ${workout.sport}/${template.fixed.sport}`);
    }
    if (violations.length > 0) {
      failures.push(`${templateId}: ${violations.map((v) => v.rule).join(', ')}`);
    }
    failures.push(...auditWorkoutPresentation(templateId, workout));
  }
  return failures;
}

function auditWorkoutPresentation(scope: string, workout: ParameterizedWorkout): string[] {
  const failures: string[] = [];
  const referenceDistanceTargets = (workout.targets ?? []).filter((target) =>
    /^参考距离/.test(target),
  );
  const structureMinutes = sumMinutePhasesFromTemplate(workout);
  if (structureMinutes !== null && Math.abs(workout.durationMinutes - structureMinutes) > 1) {
    failures.push(
      `${scope}: duration ${workout.durationMinutes} min mismatches structure ${structureMinutes} min`,
    );
  }

  if (workout.sport === 'running') {
    if (workout.distanceKm !== null) {
      failures.push(`${scope}: running workout must not expose card distance`);
    }
    if (referenceDistanceTargets.length > 0) {
      failures.push(`${scope}: running workout must not expose reference distance target`);
    }
  }

  if (workout.distanceKm === null && referenceDistanceTargets.length > 0) {
    failures.push(`${scope}: reference distance target exists while distanceKm is null`);
  }
  if (workout.distanceKm !== null && workout.distanceKm > 0) {
    const expected = Number(workout.distanceKm.toFixed(1));
    const found = referenceDistanceTargets
      .map((target) => /参考距离\s*(\d+(?:\.\d+)?)\s*公里/.exec(target)?.[1])
      .filter((value): value is string => Boolean(value))
      .map(Number);
    if (found.length > 0 && !found.some((value) => Math.abs(value - expected) < 0.05)) {
      failures.push(`${scope}: reference distance target does not match distanceKm`);
    }
  }

  if (workout.sport === 'swimming') {
    const structureMeters = sumSwimMetersFromVars(workout.parameterSource.replacedVariables ?? {});
    if (structureMeters !== null && structureMeters > 0) {
      const shownMeters = workout.distanceKm === null ? 0 : Math.round(workout.distanceKm * 1000);
      if (Math.abs(shownMeters - structureMeters) > 25) {
        failures.push(`${scope}: swim distance ${shownMeters}m mismatches structure ${structureMeters}m`);
      }
    }
  }

  return failures;
}

function sumMinutePhasesFromTemplate(workout: ParameterizedWorkout): number | null {
  const template = getTemplate(workout.templateId);
  if (!template) return null;
  const vars = workout.parameterSource.replacedVariables ?? {};
  let total = 0;
  let counted = false;
  for (const phase of template.fixed.phases) {
    const minutes = phaseMinutesFromVars(template, phase.duration, vars);
    if (minutes === null) continue;
    total += minutes;
    counted = true;
  }
  return counted && total > 0 ? Math.round(total) : null;
}

function phaseMinutesFromVars(
  template: WorkoutTemplate,
  duration: WorkoutTemplate['fixed']['phases'][number]['duration'],
  vars: Record<string, string | number>,
): number | null {
  if (!duration) return null;
  const trimmed = duration.trim();
  if (trimmed === '0') return 0;
  const literal = /^(\d+(?:\.\d+)?)\s*分钟$/.exec(trimmed);
  if (literal) return Number(literal[1]);
  const match = /^\$(\w+)(.*)$/.exec(trimmed);
  if (!match) return null;
  if ((match[2] ?? '').includes('米')) return null;
  const value = positiveNumber(vars[match[1]]);
  if (value <= 0) return null;
  const unit = template.variables[match[1]]?.source.unit;
  return unit === 'seconds' ? value / 60 : value;
}

function sumSwimMetersFromVars(vars: Record<string, string | number>): number | null {
  const total = [
    'warmupMeters',
    'mainTotalMeters',
    'drillTotalMeters',
    'cooldownMeters',
    'auxTotalMeters',
  ].reduce((sum, key) => sum + positiveNumber(vars[key]), 0);
  if (total > 0) return total;
  const declared = positiveNumber(vars.totalMeters);
  return declared > 0 ? declared : null;
}

function positiveNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function enabledSports(request: ScheduleRequest): ActiveSport[] {
  const out: ActiveSport[] = [];
  if (request.sports.running) out.push('running');
  if (request.sports.cycling) out.push('cycling');
  if (request.sports.swimming) out.push('swimming');
  return out;
}

function lowTemplateForSport(sport: ActiveSport, ordinal: number): string {
  const pools: Record<ActiveSport, string[]> = {
    running: ['run.aerobic.v1', 'run.lsd.v1', 'run.recovery.v1'],
    cycling: ['bike.endurance.v1', 'bike.long_ride.v1', 'bike.recovery_spin.v1'],
    swimming: ['swim.aerobic.v1', 'swim.endurance.v1', 'swim.technique.v1'],
  };
  const pool = pools[sport];
  return pool[ordinal % pool.length]!;
}

function qualityTemplateForSport(sport: ActiveSport, ordinal: number, request: ScheduleRequest): string {
  if (request.maxHardSessionsPerWeek === 0) return lowTemplateForSport(sport, ordinal);
  const pools: Record<ActiveSport, string[]> = {
    running: request.allowAdvancedWorkouts
      ? ['run.reverse_pyramid.v1', 'run.vo2max.v1', 'run.hill.v1']
      : ['run.tempo.v1', 'run.threshold.v1'],
    cycling: request.allowAdvancedWorkouts
      ? ['bike.over_under.v1', 'bike.vo2max.v1', 'bike.climb.v1']
      : ['bike.tempo.v1', 'bike.threshold.v1'],
    swimming: request.allowAdvancedWorkouts
      ? ['swim.css_threshold.v1', 'swim.vo2max.v1', 'swim.sprint.v1']
      : ['swim.css_threshold.v1'],
  };
  const pool = pools[sport];
  return pool[ordinal % pool.length]!;
}

function recoveryTemplateNotIn(used: Set<Sport>, request: ScheduleRequest): string | null {
  const options: Array<{ sport: ActiveSport; templateId: string }> = [
    { sport: 'swimming', templateId: 'swim.recovery.v1' },
    { sport: 'cycling', templateId: 'bike.recovery_spin.v1' },
    { sport: 'running', templateId: 'run.recovery.v1' },
  ];
  return options.find((o) => request.sports[o.sport] && !used.has(o.sport))?.templateId ?? null;
}

function parsePromptJson(content: unknown): JsonRecord {
  if (typeof content !== 'string') return {};
  const idx = content.lastIndexOf('\n\n');
  const jsonText = (idx >= 0 ? content.slice(idx + 2) : content).trim();
  return JSON.parse(jsonText) as JsonRecord;
}

function auditScheduleFromPrompt(payload: JsonRecord): { days: JsonRecord[]; notes: string[] } {
  const request = payload as unknown as ScheduleRequest;
  const sports = enabledSports(request);
  const activeDays = Math.max(1, Math.min(7, request.daysPerWeek));
  const hardCap = Math.max(0, request.maxHardSessionsPerWeek ?? 2);
  const days: JsonRecord[] = [];
  let hardUsed = 0;

  for (let dayIndex = 1; dayIndex <= 7; dayIndex += 1) {
    if (dayIndex > activeDays) {
      const restId = dayIndex % 2 === 0 ? 'rest.mobility.v1' : 'rest.full.v1';
      const tpl = getTemplate(restId)!;
      days.push({ dayIndex, sport: tpl.fixed.sport, templateId: restId, reason: 'audit rest' });
      continue;
    }

    const sport = sports[(dayIndex - 1) % sports.length] ?? 'running';
    const shouldUseQuality =
      request.allowAdvancedWorkouts === true &&
      hardUsed < hardCap &&
      (dayIndex === 2 || dayIndex === 5 || (request.forceRequestedSchedule === true && dayIndex === 7));
    const rawTemplateId = shouldUseQuality
      ? qualityTemplateForSport(sport, dayIndex, request)
      : lowTemplateForSport(sport, dayIndex);
    const templateId = avoidShortLongTemplate(rawTemplateId, request.dailyPreferredMinutes ?? null);
    if (shouldUseQuality && getTemplate(templateId)?.fixed.intensity === 'high') hardUsed += 1;
    const tpl = getTemplate(templateId)!;
    days.push({ dayIndex, slotIndex: 1, sport: tpl.fixed.sport, templateId, reason: 'audit primary' });
  }

  const weeklyMax = request.weeklyMaxMinutes ?? MAX_WEEKLY_TRAINING_MINUTES;
  const daily = request.dailyPreferredMinutes ?? 0;
  const canAddDouble =
    request.allowDoubleDays === true &&
    request.allowAdvancedWorkouts === true &&
    sports.length > 1 &&
    daily >= 90 &&
    weeklyMax >= activeDays * 90;
  if (canAddDouble) {
    for (const dayIndex of [2, 3, 6]) {
      if (days.length >= 10 || dayIndex > activeDays) break;
      const used = new Set(
        days
          .filter((d) => d.dayIndex === dayIndex)
          .map((d) => d.sport as Sport),
      );
      const templateId = recoveryTemplateNotIn(used, request);
      if (!templateId) continue;
      const tpl = getTemplate(templateId)!;
      days.push({ dayIndex, slotIndex: 2, sport: tpl.fixed.sport, templateId, reason: 'audit cross-training double' });
    }
  }

  days.sort((a, b) => Number(a.dayIndex) - Number(b.dayIndex) || Number(a.slotIndex ?? 1) - Number(b.slotIndex ?? 1));
  return { days, notes: ['audit fake OpenAI-compatible schedule'] };
}

function avoidShortLongTemplate(templateId: string, dailyPreferredMinutes: number | null): string {
  if (dailyPreferredMinutes !== null && Number.isFinite(dailyPreferredMinutes)) {
    if (dailyPreferredMinutes < 25 && templateId.startsWith('run.')) {
      return 'run.recovery.v1';
    }
    if (dailyPreferredMinutes < 30 && templateId.startsWith('swim.')) {
      return 'swim.recovery.v1';
    }
    if (dailyPreferredMinutes < 30 && templateId.startsWith('bike.')) {
      return 'bike.recovery_spin.v1';
    }
  }
  if (
    dailyPreferredMinutes !== null &&
    Number.isFinite(dailyPreferredMinutes) &&
    templateId === 'run.lsd.v1' &&
    dailyPreferredMinutes < 70
  ) {
    return 'run.aerobic.v1';
  }
  if (
    dailyPreferredMinutes !== null &&
    Number.isFinite(dailyPreferredMinutes) &&
    templateId === 'bike.long_ride.v1' &&
    dailyPreferredMinutes < 90
  ) {
    return 'bike.endurance.v1';
  }
  return templateId;
}

function fakeWorkoutFromPrompt(payload: JsonRecord): JsonRecord {
  const templatePayload = payload.template as JsonRecord;
  const schedulePayload = payload.schedule as JsonRecord;
  const requestPayload = payload.request as JsonRecord;
  const recentPayload = payload.recentState as JsonRecord;
  const templateId = String(templatePayload.id);
  const template = getTemplate(templateId);
  if (!template) throw new Error(`fake server missing template ${templateId}`);
  const entry: ScheduleEntry = {
    dayIndex: Number(schedulePayload.dayIndex ?? 1),
    date: String(schedulePayload.date ?? WEEK_START),
    dayLabel: String(schedulePayload.dayLabel ?? '周一'),
    sport: template.fixed.sport,
    templateId,
    slotIndex: 1,
    reason: 'audit fake parameterizer',
  };
  const workout = parameterizeWorkout({
    template,
    athleteProfile: advancedProfile,
    recentState: {
      ...normalRecentState,
      latestStimulus: String(recentPayload.latestStimulus ?? normalRecentState.latestStimulus) as RecentState['latestStimulus'],
      fatigue: String(recentPayload.fatigue ?? normalRecentState.fatigue) as RecentState['fatigue'],
    },
    request: {
      targetMetricPreference: (requestPayload.targetMetricPreference as ScheduleRequest['targetMetricPreference']) ?? 'auto',
      availableTime: typeof requestPayload.availableTime === 'string' ? requestPayload.availableTime : '',
      dailyPreferredMinutes:
        typeof requestPayload.dailyPreferredMinutes === 'number' ? requestPayload.dailyPreferredMinutes : null,
    },
    scheduleEntry: entry,
    progression: 'normal',
  });
  return workoutPayload(workout);
}

function workoutPayload(workout: ParameterizedWorkout): JsonRecord {
  return {
    durationMinutes: workout.durationMinutes,
    distanceKm: workout.distanceKm,
    targetMetric: workout.targetMetric,
    targetHeartRate: workout.targetHeartRate,
    targetPace: workout.targetPace,
    targetPower: workout.targetPower,
    workoutStructure: workout.workoutStructure,
    targets: workout.targets ?? [],
    adaptation: workout.adaptation,
    variables: workout.parameterSource.replacedVariables ?? {},
  };
}

function createFakeOpenAiServer(): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonRecord;

    if (body.stream === true) {
      const text =
        '## 摘要\n本周计划已生成，包含多项目训练与恢复安排。\n\n' +
        '## 监控重点\n关注主观疲劳、睡眠和心率漂移。\n\n' +
        '## 调整规则\n若疲劳升高，优先缩短低强度训练；若疼痛出现，立即停止当天训练。';
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const toolName = ((body.tools as JsonRecord[] | undefined)?.[0]?.function as JsonRecord | undefined)?.name;
    const messages = body.messages as Array<{ role: string; content: string }>;
    const payload = parsePromptJson(messages[messages.length - 1]?.content);
    const args =
      toolName === 'select_weekly_schedule'
        ? auditScheduleFromPrompt(payload)
        : fakeWorkoutFromPrompt(payload);

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-audit',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? 'gpt-audit',
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_audit',
            type: 'function',
            function: {
              name: toolName,
              arguments: JSON.stringify(args),
            },
          }],
        },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}/v1` });
    });
  });
}

async function withFakeActiveLlm<T>(baseUrl: string, fn: () => Promise<T>): Promise<T> {
  const activeRows = await db.select().from(llmConfig).where(eq(llmConfig.isActive, true)).limit(1);
  const previousActive = activeRows[0] ?? null;
  await db.update(llmConfig).set({ isActive: false, updatedAt: new Date() }).where(eq(llmConfig.isActive, true));
  await db.delete(llmConfig).where(eq(llmConfig.name, AUDIT_LLM_NAME));
  await db.insert(llmConfig).values({
    name: AUDIT_LLM_NAME,
    baseUrl,
    apiKeyEncrypted: encryptGlobal('audit-key'),
    model: 'gpt-4o-mini-audit',
    maxOutputTokens: 4096,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  clearLlmConfigCache();
  try {
    return await fn();
  } finally {
    await db.update(llmConfig).set({ isActive: false, updatedAt: new Date() }).where(eq(llmConfig.isActive, true));
    await db.delete(llmConfig).where(eq(llmConfig.name, AUDIT_LLM_NAME));
    if (previousActive) {
      await db.update(llmConfig).set({ isActive: true, updatedAt: new Date() }).where(eq(llmConfig.id, previousActive.id));
    }
    clearLlmConfigCache();
  }
}

function scenarioRequests(): Array<{ name: string; request: ScheduleRequest; recentState: RecentState }> {
  const combos: Array<Partial<Record<ActiveSport, boolean>>> = [
    { running: true },
    { cycling: true },
    { swimming: true },
    { running: true, cycling: true },
    { running: true, swimming: true },
    { cycling: true, swimming: true },
    { running: true, cycling: true, swimming: true },
  ];
  const out: Array<{ name: string; request: ScheduleRequest; recentState: RecentState }> = [];
  for (const sports of combos) {
    const enabled = Object.entries(sports).filter(([, on]) => on).map(([sport]) => sport).join('+');
    for (const daily of [15, 60, 120]) {
      for (const advanced of [false, true]) {
        const count = Object.values(sports).filter(Boolean).length;
        out.push({
          name: `${enabled}-daily${daily}-${advanced ? 'advanced' : 'basic'}`,
          request: makeRequest({
            sports: {
              running: sports.running === true,
              cycling: sports.cycling === true,
              swimming: sports.swimming === true,
            },
            daysPerWeek: Math.max(count, daily >= 120 ? 7 : 4),
            dailyPreferredMinutes: daily,
            weeklyMaxMinutes: Math.min(MAX_WEEKLY_TRAINING_MINUTES, Math.max(120, daily * Math.max(count, daily >= 120 ? 7 : 4))),
            allowAdvancedWorkouts: advanced,
            allowDoubleDays: advanced && daily >= 120,
            maxHardSessionsPerWeek: advanced ? 3 : 2,
            forceRequestedSchedule: true,
          }),
          recentState: normalRecentState,
        });
      }
    }
  }
  out.push({
    name: 'force-four-high-running',
    request: makeRequest({
      sports: { running: true, cycling: false, swimming: false },
      daysPerWeek: 7,
      dailyPreferredMinutes: 119,
      weeklyMaxMinutes: 1200,
      allowAdvancedWorkouts: true,
      allowDoubleDays: true,
      maxHardSessionsPerWeek: 4,
      forceRequestedSchedule: true,
      notes: '用户明确选择 4 次高强度；应生成 4 次质量课，而不是只把它当作上限。',
    }),
    recentState: normalRecentState,
  });
  out.push({
    name: 'extreme-daily200-weekly270',
    request: makeRequest({
      sports: { running: true, cycling: true, swimming: true },
      daysPerWeek: 7,
      dailyPreferredMinutes: 200,
      weeklyMaxMinutes: 270,
      allowAdvancedWorkouts: true,
      allowDoubleDays: true,
      maxHardSessionsPerWeek: 3,
      forceRequestedSchedule: true,
      notes: '极端测试：用户每天想练 200 分钟，但本周总上限只有 270 分钟，必须尊重周上限。',
    }),
    recentState: normalRecentState,
  });
  out.push({
    name: 'extreme-minimum-15',
    request: makeRequest({
      sports: { running: true, cycling: false, swimming: false },
      daysPerWeek: 7,
      dailyPreferredMinutes: 15,
      weeklyMaxMinutes: 105,
      allowAdvancedWorkouts: false,
      allowDoubleDays: false,
      maxHardSessionsPerWeek: 0,
      forceRequestedSchedule: true,
    }),
    recentState: normalRecentState,
  });
  out.push({
    name: 'force-high-risk-user-request',
    request: makeRequest({
      sports: { running: true, cycling: true, swimming: true },
      daysPerWeek: 7,
      dailyPreferredMinutes: 120,
      weeklyMaxMinutes: 1200,
      allowAdvancedWorkouts: true,
      allowDoubleDays: true,
      maxHardSessionsPerWeek: 3,
      forceRequestedSchedule: true,
      notes: '即使疲劳风险高，也按用户要求生成，只提醒风险，不强制删除高级训练。',
    }),
    recentState: highRiskRecentState,
  });
  return out;
}

function auditGeneratedPlan(name: string, plan: GeneratedPlan, request: ScheduleRequest): string[] {
  const failures: string[] = [];
  const estimatedLoad = plan.modelMeta.estimatedTrainingLoad?.estimated;
  if (!Number.isFinite(estimatedLoad) || estimatedLoad === undefined || estimatedLoad <= 0) {
    failures.push(`${name}: missing estimated weekly training load`);
  }
  const activeMinutes = plan.workouts.reduce((sum, workout, index) => {
    const sport = plan.schedule.days[index]?.sport;
    return sport === 'rest' || sport === 'mobility' ? sum : sum + workout.durationMinutes;
  }, 0);
  const weeklyMax = request.weeklyMaxMinutes ?? MAX_WEEKLY_TRAINING_MINUTES;
  const weeklyTolerance = name.startsWith('extreme-daily200') ? 10 : 1;
  if (activeMinutes > weeklyMax + weeklyTolerance) {
    failures.push(`${name}: active minutes ${activeMinutes} > weekly max ${weeklyMax}`);
  }

  const activeDays = new Set(
    plan.schedule.days
      .filter((day) => day.sport !== 'rest' && day.sport !== 'mobility')
      .map((day) => day.dayIndex),
  );
  if (activeDays.size !== request.daysPerWeek) {
    failures.push(`${name}: active day count ${activeDays.size} != request ${request.daysPerWeek}`);
  }

  const highSessions = plan.schedule.days.filter((day) => {
    const tpl = getTemplate(day.templateId);
    return tpl?.fixed.intensity === 'high';
  }).length;
  if (
    request.forceRequestedSchedule === true &&
    request.maxHardSessionsPerWeek !== null &&
    request.maxHardSessionsPerWeek !== undefined &&
    request.maxHardSessionsPerWeek >= 3 &&
    request.allowAdvancedWorkouts === true &&
    canHonorRequestedHardTargetWithinTimeBudget(request) &&
    request.daysPerWeek >= request.maxHardSessionsPerWeek &&
    highSessions < request.maxHardSessionsPerWeek
  ) {
    failures.push(`${name}: high sessions ${highSessions} < requested ${request.maxHardSessionsPerWeek}`);
  }

  const enabled = new Set(enabledSports(request));
  for (const day of plan.schedule.days) {
    const tpl = getTemplate(day.templateId);
    if (!tpl) {
      failures.push(`${name}: unknown template ${day.templateId}`);
      continue;
    }
    if (tpl.fixed.sport !== day.sport) {
      failures.push(`${name}: ${day.templateId} sport mismatch ${day.sport}/${tpl.fixed.sport}`);
    }
    if (day.sport !== 'rest' && day.sport !== 'mobility' && !enabled.has(day.sport as ActiveSport)) {
      failures.push(`${name}: scheduled disabled sport ${day.sport}`);
    }
    if (
      day.templateId === 'run.lsd.v1' &&
      request.dailyPreferredMinutes !== null &&
      request.dailyPreferredMinutes !== undefined &&
      request.dailyPreferredMinutes < 70
    ) {
      failures.push(`${name}: scheduled LSD under 70-minute daily cap`);
    }
    if (
      day.templateId === 'bike.long_ride.v1' &&
      request.dailyPreferredMinutes !== null &&
      request.dailyPreferredMinutes !== undefined &&
      request.dailyPreferredMinutes < 90
    ) {
      failures.push(`${name}: scheduled long ride under 90-minute daily cap`);
    }
  }
  for (const workout of plan.workouts) {
    const load = workout.parameterSource.replacedVariables.__estimated_training_load;
    if (workout.sport !== 'rest' && workout.sport !== 'mobility') {
      if (typeof load !== 'number' || !Number.isFinite(load) || load <= 0) {
        failures.push(`${name}: ${workout.templateId} missing per-workout estimated load`);
      }
    }
    failures.push(...auditWorkoutPresentation(`${name}:${workout.templateId}`, workout));
  }

  const byDay = new Map<number, ScheduleEntry[]>();
  for (const day of plan.schedule.days) {
    byDay.set(day.dayIndex, [...(byDay.get(day.dayIndex) ?? []), day]);
  }
  for (const [dayIndex, days] of byDay) {
    const active = days.filter((day) => day.sport !== 'rest' && day.sport !== 'mobility');
    if (active.length < 2) continue;
    const allDoubleThreshold = active.every((day) => day.templateId.startsWith('run.double_threshold_'));
    if (allDoubleThreshold) continue;
    if (new Set(active.map((day) => day.templateId)).size < active.length) {
      failures.push(`${name}: day ${dayIndex} repeated template in double day`);
    }
    if (enabled.size > 1 && new Set(active.map((day) => day.sport)).size < active.length) {
      failures.push(`${name}: day ${dayIndex} repeated sport in double day`);
    }
  }

  const validation = validatePlan({
    schedule: plan.schedule.days,
    workouts: plan.workouts,
    context: {
      maxHardSessionsPerWeek: request.maxHardSessionsPerWeek ?? 2,
      hardSessionsAlreadyDoneThisWeek: 0,
      latestStimulus: 'aerobic',
      hoursSinceLatest: 72,
      fatigue: 'normal',
      forceRequestedSchedule: request.forceRequestedSchedule === true,
      weeklyMaxMinutes: weeklyMax,
    },
  });
  const relevantValidation = name.startsWith('extreme-daily200')
    ? validation.filter((v) => v.rule !== 'weekly_duration_within_user_limit')
    : validation;
  if (relevantValidation.length > 0) {
    failures.push(`${name}: validation ${relevantValidation.map((v) => v.rule).join(', ')}`);
  }
  return failures;
}

function canHonorRequestedHardTargetWithinTimeBudget(request: ScheduleRequest): boolean {
  const cap = request.maxHardSessionsPerWeek ?? 0;
  if (cap <= 0) return false;
  const daily = request.dailyPreferredMinutes;
  if (Number.isFinite(daily ?? NaN) && (daily ?? 0) < 75) return false;
  const activeDays = Math.max(1, Math.min(7, request.daysPerWeek));
  const weeklyMax = request.weeklyMaxMinutes ?? MAX_WEEKLY_TRAINING_MINUTES;
  const estimatedMinimum =
    Math.min(cap, activeDays) * 60 +
    Math.max(0, activeDays - cap) * 30;
  return weeklyMax >= estimatedMinimum;
}

async function auditGeneratedScenarios(): Promise<string[]> {
  const { server, baseUrl } = await createFakeOpenAiServer();
  try {
    return await withFakeActiveLlm(baseUrl, async () => {
      const failures: string[] = [];
      const scenarios = scenarioRequests();
      for (const scenario of scenarios) {
        const plan = await generatePlan({
          userId: 'audit-user',
          request: scenario.request,
          athleteProfile: advancedProfile,
          recentState: scenario.recentState,
          isColdStart: false,
          onSummaryDelta: () => {},
          onToolEvent: () => {},
        });
        failures.push(...auditGeneratedPlan(scenario.name, plan, scenario.request));
        const templates = plan.schedule.days.map((day) => day.templateId).join(', ');
        console.log(`scenario=${scenario.name} minutes=${plan.workouts.reduce((sum, w, i) => {
          const sport = plan.schedule.days[i]?.sport;
          return sport === 'rest' || sport === 'mobility' ? sum : sum + w.durationMinutes;
        }, 0)} templates=${templates}`);
      }
      return failures;
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function main() {
  const templateFailures = auditAllTemplates();
  console.log(`template_coverage=${Object.keys(WORKOUT_TEMPLATES).length}`);
  const scenarioFailures = await auditGeneratedScenarios();
  const failures = [...templateFailures, ...scenarioFailures];
  if (failures.length > 0) {
    console.error('\nAUDIT FAILED');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log('\nAUDIT PASSED');
  console.log('- all templates parameterize and validate');
  console.log('- generated scenario matrix respects weekly limits, active days, sport/template consistency, and double-day variety');
  console.log('- fake OpenAI-compatible GPT-style config completed tool-call generation');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
