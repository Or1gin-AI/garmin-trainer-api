// Plan generation orchestrator.
//
// U9: LLM-first with deterministic fallback per stage.
//
//   1) Schedule via llmBuildWeeklySchedule. On LlmNotConfiguredError or
//      InvalidLlmScheduleError (after one retry that injects the violations),
//      fall back to U7's deterministic buildWeeklySchedule.
//   2) For each day, parameterize via llmParameterizeWorkout. Each day falls
//      back independently to U7's deterministic parameterizeWorkout on error.
//   3) Run validatePlan. If violations, run U7's existing one-retry-with-
//      downgrade pass.
//   4) Stream summary / monitoring / adjustment via llmStreamSummary, with
//      onSummaryDelta forwarded to the SSE route. Fall back to deterministic
//      strings if LLM is not configured / fails.
//
// The exported signature (generatePlan, GeneratePlanInput, GeneratedPlan)
// stays compatible with U7 — only the optional onSummaryDelta callback and
// modelMeta field shape are widened.

import { setMaxListeners } from 'node:events';
import {
  applyDurationCap,
  buildWeeklySchedule,
  estimateTrainingMinutesPerActiveDay,
  MAX_WEEKLY_TRAINING_MINUTES,
  requestedDoubleDayIndex,
} from './scheduler.js';
import type { ActiveSport, ScheduleRequest, ScheduleResult, ScheduleEntry } from './scheduler.js';
import { parameterizeWorkout } from './parameterizer.js';
import type { ParameterizedWorkout } from './parameterizer.js';
import { validatePlan } from './validation.js';
import type { Violation } from './validation.js';
import type { AthleteProfile } from './athlete-profile.js';
import type { RecentState } from './recent-state.js';
import type { TrainingCapacity } from './training-capacity.js';
import { getTemplate, type Sport, type WorkoutTemplate } from './templates/index.js';
import {
  llmBuildWeeklySchedule,
  LlmNotConfiguredError,
  InvalidLlmScheduleError,
  type LlmScheduleMeta,
} from './llm-scheduler.js';
import {
  llmParameterizeWorkout,
  InvalidLlmWorkoutError,
} from './llm-parameterizer.js';
import { llmStreamSummary, type SummaryDeltaKind } from './llm-summary.js';
import {
  extractTrainingRequestIntent,
  isTemplateEnabledByRequest,
  missingRequiredWorkoutMessages,
  type TrainingRequestIntent,
} from './request-intent.js';
import {
  TOOL_DISPLAY,
  dayDisplay,
  summarizeParameterized,
  summarizeValidation,
  summarizeSchedule,
} from './tool-event-labels.js';
import type { ToolEventPayload } from '../lib/sse.js';
import {
  estimateWeeklyTrainingLoad,
  estimateWorkoutTrainingLoad,
} from './load-estimator.js';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GeneratePlanInput {
  userId: string;
  request: ScheduleRequest;
  athleteProfile: AthleteProfile;
  isColdStart?: boolean;
  recentState: RecentState;
  trainingCapacity?: TrainingCapacity;
  signal?: AbortSignal;
  onSummaryDelta?: (delta: { kind: SummaryDeltaKind; text: string }) => void;
  /**
   * Optional callback that receives a stream of pseudo tool-event payloads
   * describing the orchestrator's internal stages. The route handler forwards
   * these as SSE `tool_event` messages so the user sees AI progress live.
   */
  onToolEvent?: (e: ToolEventPayload) => void;
}

export interface ModelMeta {
  provider: string;
  model: string;
  totalTokens: number;
  costCents: number;
  // Per-stage diagnostics (best-effort).
  scheduleSource: 'llm' | 'deterministic';
  parameterizerLlmCount: number;
  parameterizerFallbackCount: number;
  summarySource: 'llm' | 'deterministic';
  estimatedTrainingLoad?: {
    estimated: number;
  };
}

export interface GeneratedPlan {
  schedule: ScheduleResult;
  workouts: ParameterizedWorkout[];
  violations: Violation[];
  summary: string;
  monitoring: string;
  adjustmentRules: string;
  modelMeta: ModelMeta;
}

const HARD_STIMULI: ReadonlySet<string> = new Set(['threshold', 'vo2max', 'anaerobic']);
const DETERMINISTIC_PROVIDER = 'deterministic-fallback';
const DETERMINISTIC_MODEL = 'v1';
const PARAMETERIZE_CONCURRENCY = 3;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function generatePlan(input: GeneratePlanInput): Promise<GeneratedPlan> {
  const {
    request,
    athleteProfile,
    isColdStart = false,
    recentState,
    trainingCapacity,
    signal,
    onToolEvent,
  } = input;
  const emit = onToolEvent ?? (() => {});
  const requestIntent = extractTrainingRequestIntent(request);
  if (signal) {
    setMaxListeners(50, signal);
  }

  // Stage 1: schedule.
  const stageOne = await runScheduleStage({
    request,
    athleteProfile,
    isColdStart,
    recentState,
    trainingCapacity,
    signal,
    emit,
  });
  let schedule = stageOne.schedule;
  const progressionCapacity = request.forceRequestedSchedule ? undefined : trainingCapacity;
  schedule = applyAdvancedWorkoutPreferences(
    schedule,
    request,
    athleteProfile,
    recentState,
    trainingCapacity,
    requestIntent,
  );
  schedule = expandMultiSessionSchedule(
    schedule,
    request,
    athleteProfile,
    recentState,
    trainingCapacity,
  );
  schedule = applyExplicitWorkoutRequirements(schedule, request, requestIntent, trainingCapacity);
  schedule = normalizeDoubleDayVariety(schedule, request, athleteProfile, trainingCapacity);
  schedule = normalizeStandaloneDoubleThreshold(schedule);
  schedule = enforceUserHardWorkoutLayout(schedule, request, requestIntent);
  schedule = appendForcedScheduleRiskNotes(schedule, request, recentState, trainingCapacity);

  let totalInputTokens = stageOne.meta?.inputTokens ?? 0;
  let totalOutputTokens = stageOne.meta?.outputTokens ?? 0;
  const provider = stageOne.meta?.provider ?? DETERMINISTIC_PROVIDER;
  const model = stageOne.meta?.model ?? DETERMINISTIC_MODEL;

  // Stage 2: parameterize each day.
  let llmParamCount = 0;
  let fallbackParamCount = 0;
  const workouts: ParameterizedWorkout[] = [];

  const parameterized = await mapWithConcurrency(
    schedule.days,
    PARAMETERIZE_CONCURRENCY,
    (entry) =>
      parameterizeScheduleEntry({
        entry,
        request,
        athleteProfile,
        isColdStart,
        recentState,
        progressionCapacity,
        signal,
        emit,
      }),
  );
  for (const item of parameterized) {
    workouts.push(item.workout);
    totalInputTokens += item.inputTokens;
    totalOutputTokens += item.outputTokens;
    if (item.source === 'llm') {
      llmParamCount += 1;
    } else {
      fallbackParamCount += 1;
    }
  }

  enforceWeeklyDurationLimit(schedule, workouts, request);
  enforceWeeklyDurationTarget(
    schedule,
    workouts,
    request,
    requestIntent,
    athleteProfile,
    recentState,
  );
  enforceWeeklyDurationLimit(schedule, workouts, request);
  let loadTargetMeta = annotateWeeklyLoadEstimate({
    schedule,
    workouts,
  });

  // Stage 3: validate + retry-with-downgrade.
  const baseCap = computeBaseCap(request, athleteProfile, recentState, trainingCapacity);
  const hoursSinceLatest = computeHoursSinceLatest(recentState);
  const validationCapacity = request.forceRequestedSchedule ? undefined : trainingCapacity;

  const validateId = crypto.randomUUID();
  const validateStart = Date.now();
  emit({
    id: validateId,
    name: 'validate_plan',
    displayName: TOOL_DISPLAY.validate_plan,
    phase: 'start',
  });

  let violations = validatePlan({
    schedule: schedule.days,
    workouts,
    context: {
      maxHardSessionsPerWeek: baseCap,
      hardSessionsAlreadyDoneThisWeek: recentState.hardSessionsLast7d,
      latestStimulus: recentState.latestStimulus,
      hoursSinceLatest,
      fatigue: recentState.fatigue,
      forceRequestedSchedule: request.forceRequestedSchedule === true,
      weeklyMaxMinutes: request.weeklyMaxMinutes ?? MAX_WEEKLY_TRAINING_MINUTES,
      trainingCapacity: validationCapacity,
    },
  });

  if (violations.length > 0 && request.forceRequestedSchedule !== true) {
    const dayIndexes = collectViolatingDays(violations);
    let mutated = false;
    for (const dayIndex of dayIndexes) {
      const idx = schedule.days.findIndex((d) => d.dayIndex === dayIndex);
      const entry = schedule.days[idx];
      const current = workouts[idx];
      if (!entry || !current) continue;
      const tpl = getTemplate(current.templateId);
      const downgradeId = tpl?.fixed.downgradeTo ?? null;
      if (!downgradeId) continue;
      const downgradeTpl = getTemplate(downgradeId);
      if (!downgradeTpl) continue;
      schedule.days[idx] = {
        ...entry,
        templateId: downgradeId,
        sport: downgradeTpl.fixed.sport,
        reason: `${entry.reason ?? ''} 校验未过自动降级为 ${downgradeId}。`.trim(),
      };
      // Use deterministic parameterizer for the downgrade path so we don't
      // burn another LLM round-trip on a fix-up.
      workouts[idx] = parameterizeWorkout({
        template: downgradeTpl,
        athleteProfile,
        recentState,
        request: {
          targetMetricPreference: request.targetMetricPreference,
          availableTime: request.availableTime,
          dailyPreferredMinutes: request.dailyPreferredMinutes,
        },
        scheduleEntry: schedule.days[idx],
        progression: decideProgression(
          athleteProfile,
          recentState,
          schedule.days[idx],
          progressionCapacity,
        ),
      });
      mutated = true;
      fallbackParamCount += 1;
      llmParamCount = Math.max(0, llmParamCount - 1);
    }
    if (mutated) {
      enforceWeeklyDurationLimit(schedule, workouts, request);
      loadTargetMeta = annotateWeeklyLoadEstimate({
        schedule,
        workouts,
      });
      violations = validatePlan({
        schedule: schedule.days,
        workouts,
        context: {
          maxHardSessionsPerWeek: baseCap,
          hardSessionsAlreadyDoneThisWeek: recentState.hardSessionsLast7d,
          latestStimulus: recentState.latestStimulus,
          hoursSinceLatest,
          fatigue: recentState.fatigue,
          forceRequestedSchedule: false,
          weeklyMaxMinutes: request.weeklyMaxMinutes ?? MAX_WEEKLY_TRAINING_MINUTES,
          trainingCapacity: validationCapacity,
        },
      });
    }
  }

  emit({
    id: validateId,
    name: 'validate_plan',
    displayName: TOOL_DISPLAY.validate_plan,
    phase: 'done',
    summary: summarizeValidation(violations),
    durationMs: Date.now() - validateStart,
  });

  // Stage 4: summary.
  const summaryStage = await runSummaryStage({
    schedule,
    workouts,
    request,
    athleteProfile,
    recentState,
    trainingCapacity,
    signal,
    onDelta: input.onSummaryDelta,
    emit,
  });

  totalInputTokens += summaryStage.meta?.inputTokens ?? 0;
  totalOutputTokens += summaryStage.meta?.outputTokens ?? 0;

  const totalTokens = totalInputTokens + totalOutputTokens;

  return {
    schedule,
    workouts,
    violations,
    summary: summaryStage.summary,
    monitoring: summaryStage.monitoring,
    adjustmentRules: summaryStage.adjustmentRules,
    modelMeta: {
      provider,
      model,
      totalTokens,
      costCents: 0,
      scheduleSource: stageOne.source,
      parameterizerLlmCount: llmParamCount,
      parameterizerFallbackCount: fallbackParamCount,
      summarySource: summaryStage.source,
      estimatedTrainingLoad: loadTargetMeta,
    },
  };
}

interface ParameterizeEntryResult {
  workout: ParameterizedWorkout;
  source: 'llm' | 'fallback';
  inputTokens: number;
  outputTokens: number;
}

async function parameterizeScheduleEntry(args: {
  entry: ScheduleEntry;
  request: ScheduleRequest;
  athleteProfile: AthleteProfile;
  isColdStart: boolean;
  recentState: RecentState;
  progressionCapacity?: TrainingCapacity;
  signal?: AbortSignal;
  emit: (e: ToolEventPayload) => void;
}): Promise<ParameterizeEntryResult> {
  const {
    entry,
    request,
    athleteProfile,
    isColdStart,
    recentState,
    progressionCapacity,
    signal,
    emit,
  } = args;

  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  const tpl = getTemplate(entry.templateId) ?? getTemplate('rest.full.v1');
  if (!tpl) {
    throw new Error(`Missing template ${entry.templateId} and no rest fallback`);
  }
  const progression = decideProgression(athleteProfile, recentState, entry, progressionCapacity);
  const tplResolved: WorkoutTemplate = tpl;

  const buildFallback = (): ParameterizedWorkout =>
    parameterizeWorkout({
      template: tplResolved,
      athleteProfile,
      recentState,
      request: {
        targetMetricPreference: request.targetMetricPreference,
        availableTime: request.availableTime,
        dailyPreferredMinutes: request.dailyPreferredMinutes,
      },
      scheduleEntry: entry,
      progression,
    });

  const isRest = tplResolved.fixed.sport === 'rest' || tplResolved.fixed.sport === 'mobility';
  if (isRest) {
    return { workout: buildFallback(), source: 'fallback', inputTokens: 0, outputTokens: 0 };
  }

  const paramId = crypto.randomUUID();
  const paramDisplay = dayDisplay(entry.dayIndex, tplResolved.fixed.sport);
  const paramStart = Date.now();
  emit({
    id: paramId,
    name: 'llm_parameterize_workout',
    displayName: paramDisplay,
    phase: 'start',
  });

  try {
    const llmRes = await llmParameterizeWorkout({
      template: tplResolved,
      athleteProfile,
      recentState,
      request: {
        targetMetricPreference: request.targetMetricPreference,
        availableTime: request.availableTime,
        dailyPreferredMinutes: request.dailyPreferredMinutes,
      },
      scheduleEntry: entry,
      progression,
      isColdStart,
      signal,
    });
    const workout = {
      ...llmRes.workout,
      parameterSource: {
        ...llmRes.workout.parameterSource,
        replacedVariables: {
          ...llmRes.workout.parameterSource.replacedVariables,
          __source: 'llm',
        },
      },
    };
    emit({
      id: paramId,
      name: 'llm_parameterize_workout',
      displayName: paramDisplay,
      phase: 'done',
      summary: summarizeParameterized('llm', workout),
      durationMs: Date.now() - paramStart,
    });
    return {
      workout,
      source: 'llm',
      inputTokens: llmRes.meta.inputTokens,
      outputTokens: llmRes.meta.outputTokens,
    };
  } catch (err) {
    if (signal?.aborted) {
      throw err;
    }
    if (err instanceof InvalidLlmWorkoutError) {
      console.error(
        `[orchestrator] day ${entry.dayIndex} llm parameterize invalid: ${err.violations.join('; ')}`,
      );
    } else {
      console.error(
        `[orchestrator] day ${entry.dayIndex} llm parameterize failed: ${(err as Error).message}`,
      );
    }
    const workout = buildFallback();
    emit({
      id: paramId,
      name: 'llm_parameterize_workout',
      displayName: paramDisplay,
      phase: 'done',
      summary: summarizeParameterized('fallback', workout),
      durationMs: Date.now() - paramStart,
    });
    return { workout, source: 'fallback', inputTokens: 0, outputTokens: 0 };
  }
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await fn(items[index], index);
      }
    }),
  );
  return results;
}

export function expandMultiSessionSchedule(
  schedule: ScheduleResult,
  request: ScheduleRequest,
  athleteProfile: AthleteProfile,
  recentState: RecentState,
  trainingCapacity?: TrainingCapacity,
): ScheduleResult {
  const forceRequestedSchedule = request.forceRequestedSchedule === true;
  let expanded = expandRequestedDoubleDay(
    schedule,
    request,
    athleteProfile,
    trainingCapacity,
    forceRequestedSchedule,
  );
  const wantsDoubleThreshold =
    request.allowAdvancedWorkouts === true &&
    request.allowDoubleDays === true &&
    (hasExplicitDoubleThresholdRequest(request) ||
      shouldAutoScheduleDoubleThreshold({
        request,
        athleteProfile,
        recentState,
        trainingCapacity,
        forceRequestedSchedule,
      }));
  if (!wantsDoubleThreshold) return expanded;
  if (!request.sports.running) return expanded;
  let notes = expanded.notes;
  if (trainingCapacity && !trainingCapacity.guardrails.allowDoubleDays) {
    if (forceRequestedSchedule) {
      notes = [
        ...notes,
        '用户已明确要求同日多练；训练容量/恢复评估不建议安排，系统仍按要求生成并保留风险提示。',
      ];
    } else {
      return {
        ...expanded,
        notes: [...notes, '已请求同日多练，但训练容量/恢复评估未通过，本周保留单次训练。'],
      };
    }
  }
  if (recentState.fatigue === 'tired' || recentState.fatigue === 'high_risk') {
    if (forceRequestedSchedule) {
      notes = [
        ...notes,
        '用户已明确要求双阈值；近期疲劳偏高，系统仍按要求生成但不推荐执行。',
      ];
    } else {
      return {
        ...expanded,
        notes: [...notes, '已请求双阈值，但近期疲劳偏高，未安排同日两练。'],
      };
    }
  }
  if (athleteProfile.experienceLevel !== 'advanced') {
    if (forceRequestedSchedule) {
      notes = [
        ...notes,
        '用户已明确要求双阈值；当前能力等级未达到推荐条件，系统仍按要求生成但建议谨慎执行。',
      ];
    } else {
      return {
        ...expanded,
        notes: [...notes, '双阈值仅适合高水平且恢复正常的用户，本周保留单次阈值/节奏课。'],
      };
    }
  }

  const thresholdIdx = expanded.days.findIndex((d) => {
    const tpl = getTemplate(d.templateId);
    return d.sport === 'running' && (tpl?.fixed.workoutType === 'threshold' || tpl?.fixed.workoutType === 'tempo');
  });
  if (thresholdIdx < 0) {
    return {
      ...expanded,
      notes: [...notes, '已开启同日多练，但本周没有合适的跑步阈值日可扩展为双阈值。'],
    };
  }

  const base = expanded.days[thresholdIdx];
  const am: ScheduleEntry = {
    ...base,
    templateId: 'run.double_threshold_am.v1',
    slotIndex: 1,
    sessionLabel: '上午',
    timeOfDay: 'morning',
    reason: `${base.reason ?? ''} 双阈值上午课：短时间阈值间歇，控制乳酸与配速稳定。`.trim(),
  };
  applyDurationCap(am, forceRequestedSchedule ? undefined : trainingCapacity);
  const pm: ScheduleEntry = {
    ...base,
    templateId: 'run.double_threshold_pm.v1',
    slotIndex: 2,
    sessionLabel: '下午',
    timeOfDay: 'afternoon',
    reason: '双阈值下午课：同日第二次阈值刺激，全天阈值总时间控制在 40-70 分钟。',
  };
  applyDurationCap(pm, forceRequestedSchedule ? undefined : trainingCapacity);
  const days = [
    ...expanded.days.slice(0, thresholdIdx),
    am,
    pm,
    ...expanded.days.slice(thresholdIdx + 1),
  ].sort((a, b) => a.dayIndex - b.dayIndex || (a.slotIndex ?? 1) - (b.slotIndex ?? 1));
  return {
    days,
    notes: [...notes, `第 ${base.dayIndex} 天已安排双阈值上午/下午两练。`],
  };
}

function hasExplicitDoubleThresholdRequest(request: ScheduleRequest): boolean {
  return /双阈值|double\s*threshold/i.test(`${request.goal ?? ''}\n${request.notes ?? ''}`);
}

function shouldAutoScheduleDoubleThreshold(args: {
  request: ScheduleRequest;
  athleteProfile: AthleteProfile;
  recentState: RecentState;
  trainingCapacity?: TrainingCapacity;
  forceRequestedSchedule: boolean;
}): boolean {
  const { request, athleteProfile, recentState, trainingCapacity, forceRequestedSchedule } = args;
  if (!request.sports.running) return false;
  if (request.allowAdvancedWorkouts !== true || request.allowDoubleDays !== true) return false;
  const hardCap =
    request.maxHardSessionsPerWeek ??
    trainingCapacity?.guardrails.maxHardSessionsPerWeek ??
    2;
  if (hardCap < 3) return false;
  if (request.daysPerWeek < 6) return false;
  if (!hasLongSameDayTrainingWindow(request)) return false;
  if (forceRequestedSchedule && hasExplicitDoubleThresholdRequest(request)) return true;
  if (athleteProfile.experienceLevel !== 'advanced') return false;
  if (recentState.fatigue !== 'fresh' && recentState.fatigue !== 'normal') return false;
  if (trainingCapacity) {
    return (
      trainingCapacity.guardrails.allowDoubleDays &&
      trainingCapacity.overall.readiness === 'green' &&
      trainingCapacity.overall.readinessConfidence !== 'low'
    );
  }
  return true;
}

function hasLongSameDayTrainingWindow(request: ScheduleRequest): boolean {
  if (request.dailyPreferredMinutes !== null && request.dailyPreferredMinutes !== undefined) {
    return request.dailyPreferredMinutes >= 90;
  }
  const dailyBudget = estimateTrainingMinutesPerActiveDay(request);
  if (dailyBudget !== null && dailyBudget >= 90) return true;
  const text = [
    request.availableTime,
    request.notes,
    request.goal,
    ...(request.preferredTrainingWindows ?? []),
  ]
    .filter(Boolean)
    .join('\n');
  if (!text) return false;
  if (/(一天两练|一日两练|同日两练|双练|双课|上午.*下午|早.*晚|morning.*afternoon|morning.*evening)/i.test(text)) {
    return true;
  }
  for (const match of text.matchAll(/(\d{2,3})\s*(分钟|min|mins|minutes)/gi)) {
    const minutes = Number(match[1]);
    if (Number.isFinite(minutes) && minutes >= 90) return true;
  }
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(小时|h|hours?)/gi)) {
    const hours = Number(match[1]);
    if (Number.isFinite(hours) && hours >= 1.5) return true;
  }
  return false;
}

function applyExplicitWorkoutRequirements(
  schedule: ScheduleResult,
  request: ScheduleRequest,
  intent: TrainingRequestIntent,
  trainingCapacity?: TrainingCapacity,
): ScheduleResult {
  if (intent.requiredWorkouts.length === 0 && intent.notes.length === 0) return schedule;

  let days = sortScheduleEntries(schedule.days.slice());
  const notes = [...schedule.notes, ...intent.notes];
  const requiredIds = new Set(intent.requiredWorkouts.map((r) => r.templateId));

  if (
    requiredIds.has('run.double_threshold_am.v1') ||
    requiredIds.has('run.double_threshold_pm.v1')
  ) {
    const res = ensureDoubleThresholdPair(days, request, trainingCapacity);
    days = res.days;
    if (res.note) notes.push(res.note);
  }

  for (const required of intent.requiredWorkouts) {
    if (isDoubleThresholdTemplate(required.templateId)) continue;
    const tpl = getTemplate(required.templateId);
    if (!tpl) continue;
    if (!isTemplateEnabledByRequest(required.templateId, request)) {
      notes.push(
        `用户要求 ${required.raw}，但对应项目 ${tpl.fixed.sport} 未在本次计划中启用，未强行加入。`,
      );
      continue;
    }
    while (days.filter((d) => d.templateId === required.templateId).length < required.count) {
      const idx = chooseReplacementIndex(days, tpl.fixed.sport, requiredIds);
      if (idx < 0) {
        notes.push(`用户要求 ${required.raw}，但当前课表没有可替换课位。`);
        break;
      }
      const previous = days[idx];
      const next = replaceEntryTemplate(
        previous,
        required.templateId,
        `用户明确要求 ${required.raw}；系统用模板库自动匹配为 ${required.templateId}。`,
        request,
        trainingCapacity,
      );
      days[idx] = next;
      notes.push(
        `${previous.dayLabel} 已按用户要求由 ${previous.templateId} 调整为 ${required.templateId}。`,
      );
    }
  }

  const missing = missingRequiredWorkoutMessages(days, intent);
  if (missing.length > 0) {
    notes.push(`仍未完全满足用户显式训练要求：${missing.join('；')}。`);
  }

  return {
    days: sortScheduleEntries(days),
    notes,
  };
}

function ensureDoubleThresholdPair(
  days: ScheduleEntry[],
  request: ScheduleRequest,
  trainingCapacity?: TrainingCapacity,
): { days: ScheduleEntry[]; note?: string } {
  if (!request.sports.running) {
    return { days, note: '用户要求双阈值，但本次计划未启用跑步项目，未强行加入。' };
  }
  const hasAm = days.some((d) => d.templateId === 'run.double_threshold_am.v1');
  const hasPm = days.some((d) => d.templateId === 'run.double_threshold_pm.v1');
  if (hasAm && hasPm) return { days };

  const existingDouble = days.find((d) => isDoubleThresholdTemplate(d.templateId));
  const thresholdLike = days.find((d) => {
    const tpl = getTemplate(d.templateId);
    return (
      d.sport === 'running' &&
      (tpl?.fixed.workoutType === 'threshold' || tpl?.fixed.workoutType === 'tempo')
    );
  });
  const base =
    existingDouble ??
    thresholdLike ??
    days[chooseReplacementIndex(days, 'running', new Set(['run.double_threshold_am.v1', 'run.double_threshold_pm.v1']))];
  if (!base) return { days, note: '用户要求双阈值，但当前课表没有可替换的跑步课位。' };

  const am = replaceEntryTemplate(
    {
      ...base,
      slotIndex: 1,
      sessionLabel: '上午',
      timeOfDay: 'morning',
    },
    'run.double_threshold_am.v1',
    '用户明确要求双阈值：上午安排短时间阈值间歇。',
    request,
    trainingCapacity,
  );
  const pm = replaceEntryTemplate(
    {
      ...base,
      slotIndex: 2,
      sessionLabel: '下午',
      timeOfDay: 'afternoon',
    },
    'run.double_threshold_pm.v1',
    '用户明确要求双阈值：下午安排 1km 阈值重复跑。',
    request,
    trainingCapacity,
  );
  const nextDays = days.filter(
    (d) =>
      d.dayIndex !== base.dayIndex ||
      ((d.slotIndex ?? 1) > 2 && !isDoubleThresholdTemplate(d.templateId)),
  );
  return {
    days: sortScheduleEntries([...nextDays, am, pm]),
    note: `${base.dayLabel} 已按用户要求安排双阈值上午/下午两练；恢复风险只作为提示，不自动删除。`,
  };
}

function normalizeDoubleDayVariety(
  schedule: ScheduleResult,
  request: ScheduleRequest,
  athleteProfile: AthleteProfile,
  trainingCapacity?: TrainingCapacity,
): ScheduleResult {
  if (request.allowDoubleDays !== true) return schedule;
  const enabledSports = enabledTrainingSports(request);
  if (enabledSports.length <= 1) return schedule;
  if (allowsSameSportDoubleDay(request)) return schedule;

  const days = sortScheduleEntries(schedule.days.slice());
  const notes = schedule.notes.slice();
  let changed = false;

  for (const dayIndex of new Set(days.map((day) => day.dayIndex))) {
    const indexes = days
      .map((day, index) => ({ day, index }))
      .filter(({ day }) => day.dayIndex === dayIndex && !isRestLikeEntry(day));
    if (indexes.length < 2) continue;
    if (indexes.every(({ day }) => isDoubleThresholdTemplate(day.templateId))) continue;

    const usedSports = new Set<ScheduleEntry['sport']>();
    const usedTemplates = new Set<string>();
    for (const { day, index } of indexes) {
      const repeatsSport = usedSports.has(day.sport);
      const repeatsTemplate = usedTemplates.has(day.templateId);
      if (!repeatsSport && !repeatsTemplate) {
        usedSports.add(day.sport);
        usedTemplates.add(day.templateId);
        continue;
      }

      const replacementId = chooseCrossTrainingRecoveryTemplate(
        request,
        athleteProfile,
        usedSports,
      );
      if (!replacementId) continue;
      const replacement = replaceEntryTemplate(
        day,
        replacementId,
        `${day.reason ?? ''} 同日多练改为交叉恢复训练，避免重复堆同项目有氧。`.trim(),
        request,
        trainingCapacity,
      );
      days[index] = replacement;
      usedSports.add(replacement.sport);
      usedTemplates.add(replacement.templateId);
      notes.push(
        `${day.dayLabel} 的第二练已从 ${day.templateId} 调整为 ${replacement.templateId}，用于避免同一天重复堆同项目训练。`,
      );
      changed = true;
    }
  }

  return changed ? { days: sortScheduleEntries(days), notes } : schedule;
}

function normalizeStandaloneDoubleThreshold(schedule: ScheduleResult): ScheduleResult {
  const days = schedule.days.slice();
  const notes = schedule.notes.slice();
  const doubleDays = new Map<number, Set<string>>();
  let changed = false;

  for (const entry of days) {
    if (!isDoubleThresholdTemplate(entry.templateId)) continue;
    const set = doubleDays.get(entry.dayIndex) ?? new Set<string>();
    set.add(entry.templateId);
    doubleDays.set(entry.dayIndex, set);
  }

  for (let index = 0; index < days.length; index += 1) {
    const entry = days[index];
    if (!isDoubleThresholdTemplate(entry.templateId)) continue;
    const set = doubleDays.get(entry.dayIndex);
    const paired =
      set?.has('run.double_threshold_am.v1') === true &&
      set?.has('run.double_threshold_pm.v1') === true;
    if (paired) continue;
    days[index] = {
      ...entry,
      sport: 'running',
      templateId: 'run.threshold.v1',
      reason: `${entry.reason ?? ''} 双阈值模板需要上午/下午成对出现，已改为单次阈值课。`.trim(),
    };
    changed = true;
  }

  if (changed) {
    notes.push('检测到孤立双阈值模板，已改为普通阈值课，避免生成语义不完整的训练。');
  }
  return changed ? { days: sortScheduleEntries(days), notes } : schedule;
}

function enabledTrainingSports(request: ScheduleRequest): ActiveSport[] {
  const sports: ActiveSport[] = [];
  if (request.sports.running) sports.push('running');
  if (request.sports.cycling) sports.push('cycling');
  if (request.sports.swimming) sports.push('swimming');
  return sports;
}

function allowsSameSportDoubleDay(request: ScheduleRequest): boolean {
  if (hasExplicitDoubleThresholdRequest(request)) return true;
  const text = [request.goal, request.availableTime, request.notes]
    .filter(Boolean)
    .join('\n');
  return /(一天|一日|同日)\s*两\s*(跑|骑|游)|两练都(跑|骑|游)|同项目\s*两练|两练\s*同项目/i.test(text);
}

function chooseCrossTrainingRecoveryTemplate(
  request: ScheduleRequest,
  athleteProfile: AthleteProfile,
  usedSports: ReadonlySet<ScheduleEntry['sport']>,
): string | null {
  const options: Array<{ sport: ActiveSport; available: boolean; templateId: string }> = [
    { sport: 'swimming', available: athleteProfile.swimming.available, templateId: 'swim.recovery.v1' },
    { sport: 'cycling', available: athleteProfile.cycling.available, templateId: 'bike.recovery_spin.v1' },
    { sport: 'running', available: athleteProfile.running.available, templateId: 'run.recovery.v1' },
  ];
  const enabled = options.filter((option) => request.sports[option.sport]);
  const available = enabled.find((option) => option.available && !usedSports.has(option.sport));
  if (available) return available.templateId;
  const fallback = enabled.find((option) => !usedSports.has(option.sport));
  return fallback?.templateId ?? null;
}

function replaceEntryTemplate(
  entry: ScheduleEntry,
  templateId: string,
  reason: string,
  request: ScheduleRequest,
  trainingCapacity?: TrainingCapacity,
): ScheduleEntry {
  const tpl = getTemplate(templateId)!;
  const next: ScheduleEntry = {
    ...entry,
    sport: tpl.fixed.sport,
    templateId,
    reason,
  };
  applyDurationCap(next, request.forceRequestedSchedule === true ? undefined : trainingCapacity);
  return next;
}

function chooseReplacementIndex(
  days: ScheduleEntry[],
  preferredSport: Sport,
  requiredIds: Set<string>,
): number {
  let best: { index: number; score: number } | null = null;
  for (let index = 0; index < days.length; index += 1) {
    const entry = days[index];
    if (!entry) continue;
    const tpl = getTemplate(entry.templateId);
    if (!tpl) continue;
    let score = 0;
    if (requiredIds.has(entry.templateId)) score += 1000;
    if (isDoubleThresholdTemplate(entry.templateId)) score += 900;
    if (entry.sport !== preferredSport) score += 120;
    if (entry.sport === 'rest' || entry.sport === 'mobility') score += 90;
    if (tpl.fixed.intensity === 'high') score += 70;
    if (tpl.fixed.intensity === 'medium') score += 35;
    if (tpl.fixed.workoutType === 'lsd' || tpl.fixed.workoutType === 'long_ride') score += 30;
    score += entry.dayIndex / 10;
    if (!best || score < best.score) best = { index, score };
  }
  return best?.index ?? -1;
}

function isDoubleThresholdTemplate(templateId: string): boolean {
  return templateId === 'run.double_threshold_am.v1' || templateId === 'run.double_threshold_pm.v1';
}

function sortScheduleEntries(days: ScheduleEntry[]): ScheduleEntry[] {
  return days.slice().sort((a, b) => a.dayIndex - b.dayIndex || (a.slotIndex ?? 1) - (b.slotIndex ?? 1));
}

function applyAdvancedWorkoutPreferences(
  schedule: ScheduleResult,
  request: ScheduleRequest,
  athleteProfile: AthleteProfile,
  recentState: RecentState,
  trainingCapacity: TrainingCapacity | undefined,
  intent: TrainingRequestIntent,
): ScheduleResult {
  if (!shouldAutoIncludeAdvancedWorkout(request, athleteProfile, recentState, trainingCapacity)) {
    return schedule;
  }
  if (schedule.days.some((d) => isNonDoubleAdvancedTemplate(d.templateId))) {
    return schedule;
  }

  const templateId = chooseAutoAdvancedTemplate(request, athleteProfile);
  if (!templateId) return schedule;
  const template = getTemplate(templateId);
  if (!template) return schedule;

  const hardCap = autoAdvancedHardCap(request, trainingCapacity);
  if (
    template.fixed.intensity === 'high' &&
    hardScheduleWouldExceedCapOrSpacing(schedule.days, -1, template, hardCap)
  ) {
    return {
      ...schedule,
      notes: [
        ...schedule.notes,
        `已开启高级训练，但当前课表已达到高强度上限或存在相邻高强度日，未自动追加 ${templateId}。`,
      ],
    };
  }

  const requiredIds = new Set(intent.requiredWorkouts.map((r) => r.templateId));
  const idx = chooseAdvancedPreferenceReplacementIndex(
    schedule.days,
    templateId,
    requiredIds,
    hardCap,
  );
  if (idx < 0) return schedule;

  const previous = schedule.days[idx];
  if (!previous) return schedule;
  const next = replaceEntryTemplate(
    previous,
    templateId,
    `用户开启高级训练且训练时间充足；系统主动加入 ${templateId}，避免只生成基础模板。`,
    request,
    trainingCapacity,
  );

  const days = schedule.days.slice();
  days[idx] = next;
  return {
    days: sortScheduleEntries(days),
    notes: [
      ...schedule.notes,
      `${previous.dayLabel} 已根据高级训练偏好由 ${previous.templateId} 调整为 ${templateId}。`,
    ],
  };
}

function shouldAutoIncludeAdvancedWorkout(
  request: ScheduleRequest,
  athleteProfile: AthleteProfile,
  recentState: RecentState,
  trainingCapacity?: TrainingCapacity,
): boolean {
  if (request.allowAdvancedWorkouts !== true) return false;
  if (request.maxHardSessionsPerWeek === 0) return false;
  if (!hasAdvancedTrainingWindow(request)) return false;
  if (request.forceRequestedSchedule === true) return true;
  if (recentState.fatigue === 'tired' || recentState.fatigue === 'high_risk') return false;
  if (athleteProfile.experienceLevel !== 'advanced') return false;
  if (trainingCapacity) {
    return (
      trainingCapacity.guardrails.allowHighIntensity &&
      trainingCapacity.overall.readiness === 'green' &&
      trainingCapacity.overall.readinessConfidence !== 'low'
    );
  }
  return true;
}

function hasAdvancedTrainingWindow(request: ScheduleRequest): boolean {
  if (request.dailyPreferredMinutes !== null && request.dailyPreferredMinutes !== undefined) {
    return request.dailyPreferredMinutes >= 75;
  }
  const dailyBudget = estimateTrainingMinutesPerActiveDay(request);
  if (dailyBudget !== null && dailyBudget >= 75) return true;
  const hardCap = request.maxHardSessionsPerWeek;
  if (hardCap !== null && hardCap !== undefined && hardCap >= 3) return true;
  const text = [request.availableTime, request.notes, request.goal].filter(Boolean).join('\n');
  for (const match of text.matchAll(/(\d{2,3})\s*(分钟|min|mins|minutes)/gi)) {
    const minutes = Number(match[1]);
    if (Number.isFinite(minutes) && minutes >= 75) return true;
  }
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(小时|h|hours?)/gi)) {
    const hours = Number(match[1]);
    if (Number.isFinite(hours) && hours >= 1.25) return true;
  }
  return false;
}

function autoAdvancedHardCap(
  request: ScheduleRequest,
  trainingCapacity?: TrainingCapacity,
): number {
  return Math.max(
    0,
    Math.min(
      7,
      request.maxHardSessionsPerWeek ??
        trainingCapacity?.guardrails.maxHardSessionsPerWeek ??
        2,
    ),
  );
}

function appendForcedScheduleRiskNotes(
  schedule: ScheduleResult,
  request: ScheduleRequest,
  recentState: RecentState,
  trainingCapacity?: TrainingCapacity,
): ScheduleResult {
  if (request.forceRequestedSchedule !== true) return schedule;
  const hardDays = hardDayIndexesFromSchedule(schedule.days);
  const hardCap = autoAdvancedHardCap(request, trainingCapacity);
  const riskNotes: string[] = [];

  if (hardDays.length > hardCap) {
    riskNotes.push(
      `用户要求优先：本周保留 ${hardDays.length} 个高强度训练日，已超过当前建议上限 ${hardCap}；系统不强制删改课表，仅提示执行风险。`,
    );
  }

  const consecutivePairs = consecutiveHardDayPairs(hardDays);
  if (consecutivePairs.length > 0) {
    riskNotes.push(
      `用户要求优先：第 ${consecutivePairs.map((p) => `${p[0]}-${p[1]}`).join('、')} 天为连续高强度；系统不强制调整，请根据疲劳和睡眠主动降级。`,
    );
  }

  if (recentState.fatigue === 'tired' || recentState.fatigue === 'high_risk') {
    riskNotes.push(
      `用户要求优先：当前疲劳状态为 ${recentState.fatigue}，训练计划仍按要求生成；如 RPE、睡眠或静息心率恶化，应把当天高强度课改为低强度有氧或休息。`,
    );
  }

  if (riskNotes.length === 0) return schedule;
  return {
    ...schedule,
    notes: [...schedule.notes, ...riskNotes],
  };
}

function enforceUserHardWorkoutLayout(
  schedule: ScheduleResult,
  request: ScheduleRequest,
  intent: TrainingRequestIntent,
): ScheduleResult {
  if (request.maxHardSessionsPerWeek === null || request.maxHardSessionsPerWeek === undefined) {
    return schedule;
  }
  const cap = Math.max(0, Math.min(7, request.maxHardSessionsPerWeek));
  const requiredIds = new Set(intent.requiredWorkouts.map((r) => r.templateId));
  const days = schedule.days.slice();
  const notes = schedule.notes.slice();

  for (let guard = 0; guard < 7; guard += 1) {
    const hardDays = hardDayIndexesFromSchedule(days);
    const consecutive = consecutiveHardDayPairs(hardDays);
    if (hardDays.length <= cap && consecutive.length === 0) break;

    const idx = chooseHardLayoutDowngradeIndex(days, requiredIds, hardDays);
    if (idx < 0) {
      notes.push(
        `用户设置高强度上限 ${cap} 次，但显式要求的高强度课无法继续自动降级；系统保留课表并仅提示风险。`,
      );
      break;
    }

    const entry = days[idx];
    const tpl = getTemplate(entry.templateId);
    const downgradeId = tpl?.fixed.downgradeTo ?? null;
    const downgrade = downgradeId ? getTemplate(downgradeId) : undefined;
    if (!downgrade) break;
    days[idx] = {
      ...entry,
      sport: downgrade.fixed.sport,
      templateId: downgrade.id,
      reason: `${entry.reason ?? ''} 为满足用户设置的高强度上限/间隔，自动改为 ${downgrade.id}。`.trim(),
    };
    notes.push(
      `${entry.dayLabel} 已从 ${entry.templateId} 调整为 ${downgrade.id}，用于满足用户设置的每周高强度上限和避免连续高强度。`,
    );
  }

  return { days: sortScheduleEntries(days), notes };
}

function chooseHardLayoutDowngradeIndex(
  days: readonly ScheduleEntry[],
  requiredIds: ReadonlySet<string>,
  hardDays: readonly number[],
): number {
  const hardSet = new Set(hardDays);
  let best: { index: number; score: number } | null = null;
  for (let index = 0; index < days.length; index += 1) {
    const entry = days[index];
    const tpl = getTemplate(entry.templateId);
    const downgrade = tpl?.fixed.downgradeTo ? getTemplate(tpl.fixed.downgradeTo) : undefined;
    if (!tpl || tpl.fixed.intensity !== 'high' || !downgrade) continue;
    if (requiredIds.has(entry.templateId)) continue;
    let score = entry.dayIndex;
    if (hardSet.has(entry.dayIndex - 1)) score += 100;
    if (hardSet.has(entry.dayIndex + 1)) score += 100;
    if (best === null || score > best.score) best = { index, score };
  }
  return best?.index ?? -1;
}

function hardDayIndexesFromSchedule(days: readonly ScheduleEntry[]): number[] {
  const hardDays = new Set<number>();
  for (const day of days) {
    if (getTemplate(day.templateId)?.fixed.intensity === 'high') {
      hardDays.add(day.dayIndex);
    }
  }
  return Array.from(hardDays).sort((a, b) => a - b);
}

function consecutiveHardDayPairs(hardDays: readonly number[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let i = 1; i < hardDays.length; i += 1) {
    if (hardDays[i] === hardDays[i - 1] + 1) {
      pairs.push([hardDays[i - 1], hardDays[i]]);
    }
  }
  return pairs;
}

function chooseAutoAdvancedTemplate(
  request: ScheduleRequest,
  athleteProfile: AthleteProfile,
): string | null {
  if (request.sports.running) return 'run.reverse_pyramid.v1';
  if (request.sports.cycling) {
    return athleteProfile.cycling.ftpWatts ? 'bike.over_under.v1' : 'bike.vo2max.v1';
  }
  if (request.sports.swimming) return 'swim.vo2max.v1';
  return null;
}

function chooseAdvancedPreferenceReplacementIndex(
  days: readonly ScheduleEntry[],
  templateId: string,
  requiredIds: Set<string>,
  hardCap: number,
): number {
  const tpl = getTemplate(templateId);
  if (!tpl) return -1;
  const sameSportIndexes = days
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) =>
      entry.sport === tpl.fixed.sport &&
      entry.sport !== 'rest' &&
      entry.sport !== 'mobility' &&
      !requiredIds.has(entry.templateId) &&
      !isDoubleThresholdTemplate(entry.templateId),
    );
  const candidates = sameSportIndexes.filter(
    ({ index }) => !hardScheduleWouldExceedCapOrSpacing(days, index, tpl, hardCap),
  );
  if (candidates.length === 0) return -1;

  const thresholdLike = candidates.filter(({ entry }) => {
    const current = getTemplate(entry.templateId);
    return current?.fixed.workoutType === 'threshold' || current?.fixed.workoutType === 'tempo';
  });
  if (thresholdLike.length > 1) return thresholdLike[0].index;

  const high = candidates.find(({ entry }) => getTemplate(entry.templateId)?.fixed.intensity === 'high');
  if (high) return high.index;

  const medium = candidates.find(({ entry }) => getTemplate(entry.templateId)?.fixed.intensity === 'medium');
  if (medium) return medium.index;

  return candidates[0].index;
}

function hardScheduleWouldExceedCapOrSpacing(
  days: readonly ScheduleEntry[],
  replacementIndex: number,
  template: WorkoutTemplate,
  hardCap: number,
): boolean {
  if (template.fixed.intensity !== 'high') return false;
  const replacementDay = replacementIndex >= 0 ? days[replacementIndex]?.dayIndex : null;
  const hardDays = new Set<number>();

  for (let index = 0; index < days.length; index += 1) {
    if (index === replacementIndex) continue;
    const entry = days[index];
    const current = getTemplate(entry.templateId);
    if (current?.fixed.intensity === 'high') {
      hardDays.add(entry.dayIndex);
    }
  }

  if (replacementDay === null) {
    return hardDays.size >= hardCap;
  }

  const nextHardDays = new Set(hardDays);
  nextHardDays.add(replacementDay);
  if (nextHardDays.size > hardCap) return true;
  return hardDays.has(replacementDay - 1) || hardDays.has(replacementDay + 1);
}

function isNonDoubleAdvancedTemplate(templateId: string): boolean {
  const type = getTemplate(templateId)?.fixed.workoutType;
  return (
    type === 'vo2max' ||
    type === 'interval' ||
    type === 'reverse_pyramid' ||
    type === 'anaerobic' ||
    type === 'sprint' ||
    type === 'hill' ||
    type === 'race_pace' ||
    type === 'climb' ||
    type === 'over_under' ||
    type === 'open_water'
  );
}

function expandRequestedDoubleDay(
  schedule: ScheduleResult,
  request: ScheduleRequest,
  athleteProfile: AthleteProfile,
  trainingCapacity: TrainingCapacity | undefined,
  forceRequestedSchedule: boolean,
): ScheduleResult {
  const dayIndex = requestedDoubleDayIndex(request);
  if (dayIndex === null) return schedule;

  const existingForDay = schedule.days
    .filter((d) => d.dayIndex === dayIndex)
    .sort((a, b) => (a.slotIndex ?? 1) - (b.slotIndex ?? 1));
  const base = existingForDay[0];
  if (!base) return schedule;
  if (existingForDay.some((d) => (d.slotIndex ?? 1) > 1)) {
    return {
      ...schedule,
      notes: [...schedule.notes, `${base.dayLabel} 已按用户要求包含同日多练。`],
    };
  }

  const primary = isRestLikeEntry(base)
    ? buildRequestedDoublePrimary(base, request, athleteProfile, trainingCapacity, forceRequestedSchedule)
    : {
        ...base,
        slotIndex: 1,
        sessionLabel: base.sessionLabel ?? '上午',
        timeOfDay: base.timeOfDay ?? 'morning',
      };
  const second = buildRequestedDoubleSecond(primary, request, athleteProfile, trainingCapacity, forceRequestedSchedule);
  const days = schedule.days
    .filter((d) => !(d.dayIndex === dayIndex && (d.slotIndex ?? 1) === 1))
    .concat(primary, second)
    .sort((a, b) => a.dayIndex - b.dayIndex || (a.slotIndex ?? 1) - (b.slotIndex ?? 1));

  return {
    days,
    notes: [
      ...schedule.notes,
      `${primary.dayLabel} 已按用户要求安排一天两练：${primary.templateId} + ${second.templateId}。`,
    ],
  };
}

function isRestLikeEntry(entry: ScheduleEntry): boolean {
  return entry.sport === 'rest' || entry.sport === 'mobility';
}

function buildRequestedDoublePrimary(
  base: ScheduleEntry,
  request: ScheduleRequest,
  athleteProfile: AthleteProfile,
  trainingCapacity: TrainingCapacity | undefined,
  forceRequestedSchedule: boolean,
): ScheduleEntry {
  const templateId = choosePrimaryDoubleTemplate(request, athleteProfile);
  const tpl = getTemplate(templateId)!;
  const entry: ScheduleEntry = {
    ...base,
    sport: tpl.fixed.sport,
    templateId,
    slotIndex: 1,
    sessionLabel: '上午',
    timeOfDay: 'morning',
    reason: '用户明确要求这一天安排两练；原休息日改为低风险主训练。',
  };
  applyDurationCap(entry, forceRequestedSchedule ? undefined : trainingCapacity);
  return entry;
}

function buildRequestedDoubleSecond(
  primary: ScheduleEntry,
  request: ScheduleRequest,
  athleteProfile: AthleteProfile,
  trainingCapacity: TrainingCapacity | undefined,
  forceRequestedSchedule: boolean,
): ScheduleEntry {
  const templateId = chooseSecondDoubleTemplate(primary, request, athleteProfile);
  const tpl = getTemplate(templateId)!;
  const entry: ScheduleEntry = {
    dayIndex: primary.dayIndex,
    date: primary.date,
    dayLabel: primary.dayLabel,
    sport: tpl.fixed.sport,
    templateId,
    slotIndex: 2,
    sessionLabel: '下午',
    timeOfDay: 'afternoon',
    reason: '用户明确要求一天两练；第二练安排为低压力恢复/交叉训练。',
  };
  applyDurationCap(entry, forceRequestedSchedule ? undefined : trainingCapacity);
  return entry;
}

function choosePrimaryDoubleTemplate(
  request: ScheduleRequest,
  athleteProfile: AthleteProfile,
): string {
  const priorities = request.sportPriorities ?? [];
  for (const sport of priorities) {
    if (sport === 'running' && request.sports.running && athleteProfile.running.available) return 'run.aerobic.v1';
    if (sport === 'cycling' && request.sports.cycling && athleteProfile.cycling.available) return 'bike.endurance.v1';
    if (sport === 'swimming' && request.sports.swimming && athleteProfile.swimming.available) return 'swim.aerobic.v1';
  }
  if (request.sports.running && athleteProfile.running.available) return 'run.aerobic.v1';
  if (request.sports.cycling && athleteProfile.cycling.available) return 'bike.endurance.v1';
  if (request.sports.swimming && athleteProfile.swimming.available) return 'swim.aerobic.v1';
  if (request.sports.running) return 'run.recovery.v1';
  if (request.sports.cycling) return 'bike.recovery_spin.v1';
  if (request.sports.swimming) return 'swim.recovery.v1';
  return 'rest.mobility.v1';
}

function chooseSecondDoubleTemplate(
  primary: ScheduleEntry,
  request: ScheduleRequest,
  athleteProfile: AthleteProfile,
): string {
  if (request.sports.swimming && athleteProfile.swimming.available && primary.sport !== 'swimming') {
    return 'swim.recovery.v1';
  }
  if (request.sports.cycling && athleteProfile.cycling.available && primary.sport !== 'cycling') {
    return 'bike.recovery_spin.v1';
  }
  if (request.sports.running && athleteProfile.running.available && primary.sport !== 'running') {
    return 'run.recovery.v1';
  }
  if (request.sports.swimming) return 'swim.recovery.v1';
  if (request.sports.cycling) return 'bike.recovery_spin.v1';
  if (request.sports.running) return 'run.recovery.v1';
  return 'rest.mobility.v1';
}

// ---------------------------------------------------------------------------
// Stage 1: schedule
// ---------------------------------------------------------------------------

interface ScheduleStageResult {
  schedule: ScheduleResult;
  source: 'llm' | 'deterministic';
  meta?: LlmScheduleMeta;
}

async function runScheduleStage(args: {
  request: ScheduleRequest;
  athleteProfile: AthleteProfile;
  isColdStart?: boolean;
  recentState: RecentState;
  trainingCapacity?: TrainingCapacity;
  signal?: AbortSignal;
  emit: (e: ToolEventPayload) => void;
}): Promise<ScheduleStageResult> {
  const {
    request,
    athleteProfile,
    isColdStart = false,
    recentState,
    trainingCapacity,
    signal,
    emit,
  } = args;

  const scheduleId = crypto.randomUUID();
  const scheduleStart = Date.now();
  emit({
    id: scheduleId,
    name: 'llm_build_schedule',
    displayName: TOOL_DISPLAY.llm_build_schedule,
    phase: 'start',
  });

  let firstViolations: string[] | null = null;
  const finalize = (
    res: ScheduleStageResult,
  ): ScheduleStageResult => {
    const sportCounts: Record<string, number> = {};
    for (const d of res.schedule.days) {
      sportCounts[d.sport] = (sportCounts[d.sport] ?? 0) + 1;
    }
    emit({
      id: scheduleId,
      name: 'llm_build_schedule',
      displayName: TOOL_DISPLAY.llm_build_schedule,
      phase: 'done',
      summary: summarizeSchedule(res.source, res.schedule.days.length, sportCounts),
      durationMs: Date.now() - scheduleStart,
    });
    return res;
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    try {
      const res = await llmBuildWeeklySchedule({
        request,
        athleteProfile,
        isColdStart,
        recentState,
        trainingCapacity,
        signal,
        retryViolations: firstViolations ?? undefined,
      });
      return finalize({ schedule: res.schedule, source: 'llm', meta: res.meta });
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err instanceof LlmNotConfiguredError) {
        console.error('[orchestrator] llm scheduler not configured, using deterministic');
        break;
      }
      if (err instanceof InvalidLlmScheduleError) {
        console.error(
          `[orchestrator] llm schedule attempt ${attempt + 1} invalid: ${err.violations.join('; ')}`,
        );
        const missingToolCall = err.violations.some((v) =>
          /model did not emit tool call/i.test(v),
        );
        if (attempt === 0 && !missingToolCall) {
          firstViolations = err.violations;
          continue;
        }
        break;
      }
      console.error(
        `[orchestrator] llm schedule failed: ${(err as Error).message}`,
      );
      break;
    }
  }

  return finalize({
    schedule: buildWeeklySchedule({ request, athleteProfile, recentState, trainingCapacity }),
    source: 'deterministic',
  });
}

// ---------------------------------------------------------------------------
// Stage 4: summary
// ---------------------------------------------------------------------------

interface SummaryStageResult {
  summary: string;
  monitoring: string;
  adjustmentRules: string;
  source: 'llm' | 'deterministic';
  meta?: { inputTokens: number; outputTokens: number };
}

async function runSummaryStage(args: {
  schedule: ScheduleResult;
  workouts: ParameterizedWorkout[];
  request: ScheduleRequest;
  athleteProfile: AthleteProfile;
  recentState: RecentState;
  trainingCapacity?: TrainingCapacity;
  signal?: AbortSignal;
  onDelta?: (delta: { kind: SummaryDeltaKind; text: string }) => void;
  emit: (e: ToolEventPayload) => void;
}): Promise<SummaryStageResult> {
  const { schedule, workouts, request, athleteProfile, recentState, trainingCapacity, signal, emit } = args;
  const baseCap = computeBaseCap(request, athleteProfile, recentState, trainingCapacity);

  const summaryEventId = crypto.randomUUID();
  const summaryStart = Date.now();
  emit({
    id: summaryEventId,
    name: 'llm_stream_summary',
    displayName: TOOL_DISPLAY.llm_stream_summary,
    phase: 'start',
  });

  try {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const onDelta =
      args.onDelta ?? (() => {
        /* drop */
      });
    const res = await llmStreamSummary({
      schedule,
      workouts,
      request,
      athleteProfile,
      recentState,
      signal,
      onDelta,
    });
    if (
      res.summary.length === 0 &&
      res.monitoring.length === 0 &&
      res.adjustmentRules.length === 0
    ) {
      // Empty model output — fall through.
      throw new Error('llm summary returned empty sections');
    }
    emit({
      id: summaryEventId,
      name: 'llm_stream_summary',
      displayName: TOOL_DISPLAY.llm_stream_summary,
      phase: 'done',
      summary: '总结、监测重点与调整规则已生成',
      durationMs: Date.now() - summaryStart,
    });
    return {
      summary: res.summary,
      monitoring: res.monitoring.length > 0 ? res.monitoring : buildMonitoring(recentState),
      adjustmentRules:
        res.adjustmentRules.length > 0 ? res.adjustmentRules : buildAdjustmentRules(baseCap),
      source: 'llm',
      meta: res.meta,
    };
  } catch (err) {
    if (signal?.aborted) throw err;
    if (!(err instanceof LlmNotConfiguredError)) {
      console.error(
        `[orchestrator] llm summary fell back: ${(err as Error).message}`,
      );
    }
    const summary = buildSummary(schedule.days, recentState, baseCap);
    const monitoring = buildMonitoring(recentState);
    const adjustmentRules = buildAdjustmentRules(baseCap);
    args.onDelta?.({ kind: 'summary', text: summary });
    args.onDelta?.({ kind: 'monitoring', text: monitoring });
    args.onDelta?.({ kind: 'adjustment_rules', text: adjustmentRules });
    emit({
      id: summaryEventId,
      name: 'llm_stream_summary',
      displayName: TOOL_DISPLAY.llm_stream_summary,
      phase: 'done',
      summary: '已使用规则引擎生成总结',
      durationMs: Date.now() - summaryStart,
    });
    return {
      summary,
      monitoring,
      adjustmentRules,
      source: 'deterministic',
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeBaseCap(
  request: ScheduleRequest,
  athleteProfile: AthleteProfile,
  recentState: RecentState,
  trainingCapacity?: TrainingCapacity,
): number {
  const explicitHardCap =
    request.maxHardSessionsPerWeek !== null &&
    request.maxHardSessionsPerWeek !== undefined;
  const base =
    request.maxHardSessionsPerWeek ??
    (athleteProfile.experienceLevel === 'advanced' && recentState.fatigue !== 'tired'
      ? 3
      : 2);
  if (request.forceRequestedSchedule === true || explicitHardCap) {
    return Math.min(7, Math.max(0, base));
  }
  return trainingCapacity
    ? Math.min(base, trainingCapacity.guardrails.maxHardSessionsPerWeek)
    : base;
}

function decideProgression(
  athleteProfile: AthleteProfile,
  recentState: RecentState,
  entry: ScheduleEntry,
  trainingCapacity?: TrainingCapacity,
): 'conservative' | 'normal' | 'aggressive' {
  if (
    trainingCapacity &&
    (trainingCapacity.overall.readiness !== 'green' ||
      trainingCapacity.overall.readinessConfidence === 'low')
  ) {
    return 'conservative';
  }
  if (recentState.fatigue === 'tired' || recentState.fatigue === 'high_risk') {
    return 'conservative';
  }
  const sport = entry.sport;
  let confidence: 'low' | 'medium' | 'high' | undefined;
  if (sport === 'running') confidence = athleteProfile.running.confidence;
  if (sport === 'cycling') confidence = athleteProfile.cycling.confidence;
  if (sport === 'swimming') confidence = athleteProfile.swimming.confidence;
  if (confidence === 'low') return 'conservative';
  if (
    trainingCapacity &&
    (sport === 'running' || sport === 'cycling' || sport === 'swimming') &&
    trainingCapacity.sports[sport].confidence === 'low'
  ) {
    return 'conservative';
  }

  if (
    recentState.fatigue === 'fresh' &&
    athleteProfile.experienceLevel === 'advanced' &&
    (!trainingCapacity || trainingCapacity.overall.readiness === 'green')
  ) {
    return 'aggressive';
  }
  return 'normal';
}

interface WeeklyLoadEstimateMeta {
  estimated: number;
}

function annotateWeeklyLoadEstimate(args: {
  schedule: ScheduleResult;
  workouts: ParameterizedWorkout[];
}): WeeklyLoadEstimateMeta {
  const { schedule, workouts } = args;
  annotateEstimatedWorkoutLoads(workouts);
  const estimate = estimateWeeklyTrainingLoad(workouts).trainingLoad;
  schedule.notes.push(`预计 Garmin 周训练负荷约 ${estimate}。`);
  return { estimated: estimate };
}

function annotateEstimatedWorkoutLoads(workouts: ParameterizedWorkout[]): void {
  for (let i = 0; i < workouts.length; i += 1) {
    const estimate = estimateWorkoutTrainingLoad(workouts[i]);
    workouts[i] = {
      ...workouts[i],
      parameterSource: {
        ...workouts[i].parameterSource,
        replacedVariables: {
          ...workouts[i].parameterSource.replacedVariables,
          __estimated_training_load: estimate.trainingLoad,
          __estimated_load_tag: estimate.tag,
        },
      },
    };
  }
}

function enforceWeeklyDurationLimit(
  schedule: ScheduleResult,
  workouts: ParameterizedWorkout[],
  request: ScheduleRequest,
): void {
  const limit = normalizeWeeklyMaxMinutes(request.weeklyMaxMinutes);
  const activeIndexes = workouts
    .map((w, index) => ({ w, s: schedule.days[index], index }))
    .filter(({ w, s }) =>
      s &&
      s.sport !== 'rest' &&
      s.sport !== 'mobility' &&
      Number.isFinite(w.durationMinutes) &&
      w.durationMinutes > 0,
    );
  const total = activeIndexes.reduce((sum, { w }) => sum + w.durationMinutes, 0);
  if (total <= limit) return;

  const minSessionMinutes = 15;
  const reducible = activeIndexes.reduce(
    (sum, { w }) => sum + Math.max(0, w.durationMinutes - minSessionMinutes),
    0,
  );
  if (reducible <= 0) {
    schedule.notes.push(
      `用户周时长上限为 ${limit} 分钟，但当前训练日数量下每节课已接近最低可执行时长，无法继续压缩。`,
    );
    return;
  }

  const overflow = total - limit;
  for (const item of activeIndexes) {
    const current = item.w.durationMinutes;
    const share = Math.max(0, current - minSessionMinutes) / reducible;
    const target = current - overflow * share;
    workouts[item.index] = adjustWorkoutDuration(
      item.w,
      Math.max(minSessionMinutes, roundToFive(target)),
      limit,
      'limit',
    );
  }

  let adjustedTotal = activeWeeklyMinutes(schedule, workouts);
  while (adjustedTotal > limit) {
    const candidate = activeIndexes
      .map(({ index }) => ({ index, minutes: workouts[index].durationMinutes }))
      .filter(({ minutes }) => minutes > minSessionMinutes)
      .sort((a, b) => b.minutes - a.minutes)[0];
    if (!candidate) break;
    const nextMinutes = Math.max(
      minSessionMinutes,
      candidate.minutes - Math.min(5, adjustedTotal - limit),
    );
    const adjusted = adjustWorkoutDuration(
      workouts[candidate.index],
      nextMinutes,
      limit,
      'limit',
    );
    if (adjusted.durationMinutes === workouts[candidate.index].durationMinutes) break;
    workouts[candidate.index] = adjusted;
    adjustedTotal = activeWeeklyMinutes(schedule, workouts);
  }

  const finalTotal = activeWeeklyMinutes(schedule, workouts);
  if (finalTotal <= limit) {
    schedule.notes.push(
      `本周原始生成时长 ${total} 分钟，已按用户周上限压缩到 ${finalTotal}/${limit} 分钟。`,
    );
  } else {
    schedule.notes.push(
      `本周原始生成时长 ${total} 分钟，已尽量压缩到 ${finalTotal} 分钟，但仍超过用户周上限 ${limit} 分钟。`,
    );
  }
}

function enforceWeeklyDurationTarget(
  schedule: ScheduleResult,
  workouts: ParameterizedWorkout[],
  request: ScheduleRequest,
  intent: TrainingRequestIntent,
  athleteProfile: AthleteProfile,
  recentState: RecentState,
): void {
  const requestedTarget = intent.weeklyTargetMinutes ?? weeklyDurationTargetFromDailyPreference(request);
  if (requestedTarget === null || requestedTarget <= 0) return;

  const limit = normalizeWeeklyMaxMinutes(request.weeklyMaxMinutes);
  const target = Math.min(requestedTarget, limit);
  let total = activeWeeklyMinutes(schedule, workouts);
  if (total >= Math.round(target * 0.97)) return;

  if (activeSessionCount(schedule, workouts) === 0) return;

  let changed = false;
  const preferDoubleDays = shouldPreferDoubleDays(schedule, workouts, target, request);
  const balanced = growExistingSessionsTowardsTarget({
    schedule,
    workouts,
    request,
    target,
    capMode: preferDoubleDays ? 'balanced' : 'max',
  });
  total = balanced.total;
  changed ||= balanced.changed;

  if (preferDoubleDays && total < target && request.allowDoubleDays === true) {
    const beforeAdd = total;
    total = addLowIntensityVolumeSessions({
      schedule,
      workouts,
      request,
      athleteProfile,
      recentState,
      target,
      currentTotal: total,
    });
    changed ||= total > beforeAdd;
  }

  if (total < target) {
    const maxGrowth = growExistingSessionsTowardsTarget({
      schedule,
      workouts,
      request,
      target,
      capMode: 'max',
    });
    total = maxGrowth.total;
    changed ||= maxGrowth.changed;
  }

  if (!preferDoubleDays && total < target && request.allowDoubleDays === true) {
    const beforeAdd = total;
    total = addLowIntensityVolumeSessions({
      schedule,
      workouts,
      request,
      athleteProfile,
      recentState,
      target,
      currentTotal: total,
    });
    changed ||= total > beforeAdd;
  }

  if (!changed) {
    schedule.notes.push(
      `用户训练时长目标约 ${requestedTarget} 分钟，但当前模板下无法继续专业地拉长训练课。`,
    );
    return;
  }

  pruneStaleDurationEstimateNotes(schedule);

  if (total >= Math.round(target * 0.97)) {
    schedule.notes.push(
      `已按用户平均训练时长目标把本周训练时长调整到约 ${total}/${target} 分钟；高时长优先用低压力训练分摊，避免单次训练过长或重复堆同类有氧。`,
    );
  } else {
    schedule.notes.push(
      `用户训练时长目标约 ${requestedTarget} 分钟，当前已尽量提高到 ${total}/${target} 分钟；剩余差距不再用高强度主项硬凑。`,
    );
  }
}

function weeklyDurationTargetFromDailyPreference(request: ScheduleRequest): number | null {
  const daily = request.dailyPreferredMinutes;
  if (!Number.isFinite(daily ?? NaN) || !daily || daily <= 0) return null;
  const target = Math.round(daily * Math.max(1, Math.min(7, request.daysPerWeek)));
  return Math.max(15, target);
}

function pruneStaleDurationEstimateNotes(schedule: ScheduleResult): void {
  const stale =
    /(总时长估算|训练时长估算|当前方案约|距离\s*\d+\s*分钟目标|距离.*目标|建议.*延长.*达到|可达到约)/;
  schedule.notes.splice(
    0,
    schedule.notes.length,
    ...schedule.notes.filter((note) => !stale.test(note)),
  );
}

function growExistingSessionsTowardsTarget(args: {
  schedule: ScheduleResult;
  workouts: ParameterizedWorkout[];
  request: ScheduleRequest;
  target: number;
  capMode: 'balanced' | 'max';
}): { total: number; changed: boolean } {
  const { schedule, workouts, request, target, capMode } = args;
  let total = activeWeeklyMinutes(schedule, workouts);
  let changed = false;
  const activeIndexes = workouts
    .map((w, index) => ({ w, s: schedule.days[index], index }))
    .filter(({ w, s }) =>
      s &&
      s.sport !== 'rest' &&
      s.sport !== 'mobility' &&
      Number.isFinite(w.durationMinutes) &&
      w.durationMinutes > 0,
    );
  const tiers = [
    activeIndexes.filter(({ w }) => durationGrowthTier(w) === 'low'),
    activeIndexes.filter(({ w }) => durationGrowthTier(w) === 'medium'),
    activeIndexes.filter(({ w }) => durationGrowthTier(w) === 'high'),
  ];

  for (const tier of tiers) {
    if (total >= target) break;
    const sorted = tier
      .slice()
      .sort((a, b) => durationGrowthPriority(a.w) - durationGrowthPriority(b.w));
    let progressed = true;
    while (total < target && progressed) {
      progressed = false;
      for (const item of sorted) {
        if (total >= target) break;
        const current = workouts[item.index].durationMinutes;
        const cap = durationTargetCap(workouts[item.index], request, capMode);
        if (current >= cap) continue;
        const next = Math.min(cap, current + Math.min(10, target - total));
        const rounded = Math.max(current + 1, roundToFive(next));
        const nextMinutes = Math.min(cap, rounded, current + Math.max(5, target - total));
        if (nextMinutes <= current) continue;
        const adjusted = adjustWorkoutDuration(
          workouts[item.index],
          nextMinutes,
          target,
          'target',
        );
        if (adjusted.durationMinutes <= current) continue;
        workouts[item.index] = adjusted;
        total = activeWeeklyMinutes(schedule, workouts);
        progressed = true;
        changed = true;
      }
    }
  }
  return { total, changed };
}

function adjustWorkoutDuration(
  workout: ParameterizedWorkout,
  nextMinutes: number,
  weeklyLimit: number,
  mode: 'limit' | 'target' = 'limit',
): ParameterizedWorkout {
  const current = workout.durationMinutes;
  const durationMinutes = Math.max(0, Math.round(nextMinutes));
  if (durationMinutes === current) return workout;
  const synced = workout.sport === 'swimming'
    ? { ...workout, durationMinutes }
    : syncSimpleMainDuration(workout, durationMinutes);
  if (!synced) return workout;
  const syncedDurationMinutes = synced.durationMinutes;
  const scale =
    current > 0 && workout.distanceKm !== null && workout.sport !== 'swimming'
      ? syncedDurationMinutes / current
      : null;
  const distanceKm =
    scale && Number.isFinite(scale)
      ? Math.round(workout.distanceKm! * scale * 100) / 100
      : workout.distanceKm;
  const targets = [
    mode === 'target'
      ? `总时长 ${syncedDurationMinutes} 分钟（已按周目标 ${weeklyLimit} 分钟分配）`
      : `总时长 ${syncedDurationMinutes} 分钟（已按周上限 ${weeklyLimit} 分钟控制）`,
    ...(workout.targets ?? []).filter((t) => !/^总时长\s*\d+\s*分钟/.test(t) && !/^参考距离/.test(t)),
  ];
  if (distanceKm !== null && distanceKm > 0) {
    targets.splice(1, 0, `参考距离 ${distanceKm.toFixed(1)} 公里`);
  }
  return {
    ...synced,
    durationMinutes: syncedDurationMinutes,
    distanceKm,
    targets,
    parameterSource: {
      ...workout.parameterSource,
      replacedVariables: {
        ...synced.parameterSource.replacedVariables,
        ...(mode === 'target'
          ? { __weekly_duration_target: weeklyLimit }
          : { __weekly_duration_limit: weeklyLimit }),
        __original_duration_minutes: current,
      },
    },
  };
}

function syncSimpleMainDuration(
  workout: ParameterizedWorkout,
  durationMinutes: number,
): ParameterizedWorkout | null {
  const template = getTemplate(workout.templateId);
  const vars = workout.parameterSource.replacedVariables;
  const currentMain = Number(vars.mainDuration);
  if (
    !template ||
    !Number.isFinite(currentMain) ||
    currentMain <= 0 ||
    !template.fixed.phases.some(
      (phase) => phase.name === 'main' && phase.duration?.trim() === '$mainDuration',
    )
  ) {
    return null;
  }

  const fixedMinutes = workout.durationMinutes - currentMain;
  const requestedMain = durationMinutes - fixedMinutes;
  const nextMain =
    requestedMain < 5 && durationMinutes < workout.durationMinutes
      ? 5
      : requestedMain;
  if (!Number.isFinite(nextMain) || nextMain < 5) return null;

  const roundedMain = Math.max(5, Math.round(nextMain));
  const syncedDurationMinutes = Math.max(0, Math.round(fixedMinutes + roundedMain));
  return {
    ...workout,
    durationMinutes: syncedDurationMinutes,
    workoutStructure: replacePhaseDurationText(
      workout.workoutStructure,
      '主训练',
      currentMain,
      roundedMain,
    ),
    parameterSource: {
      ...workout.parameterSource,
      replacedVariables: {
        ...vars,
        mainDuration: roundedMain,
      },
    },
  };
}

function replacePhaseDurationText(
  structure: string,
  phaseLabel: string,
  oldMinutes: number,
  newMinutes: number,
): string {
  const oldRounded = Math.round(oldMinutes);
  const exact = new RegExp(`(${escapeRegExp(phaseLabel)}\\s+)${oldRounded}(\\s*分钟)`);
  if (exact.test(structure)) return structure.replace(exact, `$1${newMinutes}$2`);
  const fallback = new RegExp(`(${escapeRegExp(phaseLabel)}\\s+)\\d+(\\s*分钟)`);
  return structure.replace(fallback, `$1${newMinutes}$2`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function durationGrowthTier(workout: ParameterizedWorkout): 'low' | 'medium' | 'high' {
  if (workout.intensity === 'high') return 'high';
  if (workout.intensity === 'medium') return 'medium';
  return 'low';
}

function durationGrowthPriority(workout: ParameterizedWorkout): number {
  if (workout.workoutType === 'long_ride') return 0;
  if (workout.workoutType === 'lsd') return 1;
  if (workout.workoutType === 'endurance') return 2;
  if (workout.workoutType === 'aerobic') return 3;
  if (workout.workoutType === 'recovery' || workout.workoutType === 'recovery_spin') return 4;
  if (workout.intensity === 'medium') return 10;
  return 20;
}

function durationTargetCap(
  workout: ParameterizedWorkout,
  request: ScheduleRequest,
  mode: 'balanced' | 'max',
): number {
  const tpl = getTemplate(workout.templateId);
  const templateMax = tpl?.fixed.maxDurationMinutes ?? workout.durationMinutes;
  if (workout.intensity === 'high') {
    return Math.max(workout.durationMinutes, templateMax);
  }
  if (mode === 'balanced') {
    if (workout.workoutType === 'long_ride') return Math.max(workout.durationMinutes, Math.min(105, templateMax));
    if (workout.workoutType === 'lsd') return Math.max(workout.durationMinutes, Math.min(100, templateMax));
    if (workout.sport === 'cycling' && workout.workoutType === 'endurance') {
      return Math.max(workout.durationMinutes, Math.max(90, Math.min(130, templateMax + 30)));
    }
    if (workout.intensity === 'low') return Math.max(workout.durationMinutes, Math.min(100, templateMax));
    if (workout.intensity === 'medium') return Math.max(workout.durationMinutes, Math.min(90, templateMax));
    return Math.max(workout.durationMinutes, templateMax);
  }
  if (workout.workoutType === 'long_ride') return Math.max(templateMax, 180);
  if (workout.workoutType === 'lsd') return Math.max(templateMax, 150);
  if (workout.sport === 'cycling' && workout.workoutType === 'endurance') {
    return Math.max(templateMax, 150);
  }
  if (workout.intensity === 'low') return Math.max(templateMax, 120);
  if (workout.intensity === 'medium') return Math.max(templateMax, 105);
  return Math.max(templateMax, Math.min(110, templateMax + 20));
}

function shouldPreferDoubleDays(
  schedule: ScheduleResult,
  workouts: ParameterizedWorkout[],
  target: number,
  request: ScheduleRequest,
): boolean {
  if (request.allowDoubleDays !== true) return false;
  const sessions = activeSessionCount(schedule, workouts);
  if (sessions <= 0) return false;
  const preferred = request.dailyPreferredMinutes && request.dailyPreferredMinutes > 0
    ? request.dailyPreferredMinutes
    : 90;
  return target / sessions > Math.min(95, preferred * 0.85);
}

function activeSessionCount(
  schedule: ScheduleResult,
  workouts: ParameterizedWorkout[],
): number {
  let count = 0;
  for (let i = 0; i < Math.min(schedule.days.length, workouts.length); i += 1) {
    const s = schedule.days[i];
    const w = workouts[i];
    if (!s || !w) continue;
    if (s.sport === 'rest' || s.sport === 'mobility') continue;
    if (Number.isFinite(w.durationMinutes) && w.durationMinutes > 0) count += 1;
  }
  return count;
}

function addLowIntensityVolumeSessions(args: {
  schedule: ScheduleResult;
  workouts: ParameterizedWorkout[];
  request: ScheduleRequest;
  athleteProfile: AthleteProfile;
  recentState: RecentState;
  target: number;
  currentTotal: number;
}): number {
  const { schedule, workouts, request, athleteProfile, recentState, target } = args;
  let total = args.currentTotal;
  let guard = 0;
  while (total < target && guard < 7) {
    guard += 1;
    const day = chooseExtraVolumeDay(schedule, workouts, request);
    if (!day) break;
    const templateId = day.templateId;
    const tpl = getTemplate(templateId);
    if (!tpl) break;
    const remaining = target - total;
    const minutes = Math.max(
      minimumExtraSessionMinutes(templateId),
      Math.min(day.maxExtraMinutes, roundToFive(remaining)),
    );
    const usedSlots = schedule.days
      .filter((d) => d.dayIndex === day.entry.dayIndex)
      .map((d) => d.slotIndex ?? 1);
    const slotIndex = 2;
    if (usedSlots.includes(slotIndex)) break;

    const entry: ScheduleEntry = {
      dayIndex: day.entry.dayIndex,
      date: day.entry.date,
      dayLabel: day.entry.dayLabel,
      sport: tpl.fixed.sport,
      templateId,
      slotIndex,
      sessionLabel: '训练 2',
      timeOfDay: 'evening',
      reason: day.reason,
    };
    const baseWorkout = parameterizeWorkout({
      template: tpl,
      athleteProfile,
      recentState,
      request: {
        targetMetricPreference: request.targetMetricPreference,
        availableTime: request.availableTime,
        dailyPreferredMinutes: null,
      },
      scheduleEntry: entry,
      progression: 'normal',
    });
    const workout = adjustWorkoutDuration(baseWorkout, minutes, target, 'target');
    insertScheduleWorkout(schedule, workouts, entry, workout);
    total = activeWeeklyMinutes(schedule, workouts);
  }
  return total;
}

function extraSessionCap(request: ScheduleRequest, existingDayMinutes: number): number {
  const daily = request.dailyPreferredMinutes && request.dailyPreferredMinutes > 0
    ? request.dailyPreferredMinutes
    : 75;
  const dayCap = Math.round(daily * 1.1);
  const remainingDayBudget = dayCap - existingDayMinutes;
  return Math.max(0, Math.min(60, remainingDayBudget));
}

interface ExtraVolumeDayCandidate {
  entry: ScheduleEntry;
  templateId: string;
  maxExtraMinutes: number;
  reason: string;
  hasHigh: boolean;
  minutes: number;
  index: number;
}

function chooseExtraVolumeDay(
  schedule: ScheduleResult,
  workouts: ParameterizedWorkout[],
  request: ScheduleRequest,
): ExtraVolumeDayCandidate | null {
  const seenDays = new Set<number>();
  const candidates: ExtraVolumeDayCandidate[] = [];

  for (let index = 0; index < schedule.days.length; index += 1) {
    const entry = schedule.days[index];
    if (seenDays.has(entry.dayIndex)) continue;
    seenDays.add(entry.dayIndex);
    if (entry.sport === 'rest' || entry.sport === 'mobility') continue;

    const dayWorkouts = schedule.days
      .map((d, i) => ({ d, w: workouts[i] }))
      .filter(({ d }) => d.dayIndex === entry.dayIndex);
    const slots = dayWorkouts.length;
    if (slots >= 2) continue;

    const hasHigh = dayWorkouts.some(({ w }) => w?.intensity === 'high');
    if (hasHigh) continue;
    if (dayWorkouts.some(({ w }) => isLongEnduranceWorkout(w))) continue;

    const minutes = dayWorkouts.reduce((sum, { w }) => sum + (w?.durationMinutes ?? 0), 0);
    const maxExtraMinutes = roundToFive(extraSessionCap(request, minutes));
    const templateId = chooseExtraVolumeTemplate(request, dayWorkouts);
    if (!templateId) continue;
    const minMinutes = minimumExtraSessionMinutes(templateId);
    if (maxExtraMinutes < minMinutes) continue;
    if (dayWorkouts.some(({ d }) => d.templateId === templateId)) continue;

    const tpl = getTemplate(templateId);
    if (!tpl) continue;
    candidates.push({
      entry,
      templateId,
      maxExtraMinutes,
      reason:
        tpl.fixed.sport === entry.sport
          ? '用户高时长目标；新增一节短恢复训练，与当天主课区分，不重复堆有氧强度。'
          : '用户高时长目标；新增一节低压力交叉训练，与当天主课区分，避免重复堆同项目有氧。',
      hasHigh,
      minutes,
      index,
    });
  }

  return candidates
    .sort((a, b) => {
      if (a.hasHigh !== b.hasHigh) return a.hasHigh ? 1 : -1;
      if (a.minutes !== b.minutes) return a.minutes - b.minutes;
      return a.index - b.index;
    })[0] ?? null;
}

function chooseExtraVolumeTemplate(
  request: ScheduleRequest,
  dayWorkouts: Array<{ d: ScheduleEntry; w: ParameterizedWorkout | undefined }>,
): string | null {
  const sportsToday = new Set(dayWorkouts.map(({ d }) => d.sport));
  const options: Array<{ sport: ActiveSport; templateId: string }> = [
    { sport: 'cycling', templateId: 'bike.recovery_spin.v1' },
    { sport: 'swimming', templateId: 'swim.recovery.v1' },
    { sport: 'running', templateId: 'run.recovery.v1' },
  ];

  for (const option of options) {
    if (!request.sports[option.sport]) continue;
    if (!sportsToday.has(option.sport)) return option.templateId;
  }
  if (options.filter((option) => request.sports[option.sport]).length > 1) {
    return null;
  }
  for (const option of options) {
    if (!request.sports[option.sport]) continue;
    return option.templateId;
  }
  return null;
}

function isLongEnduranceWorkout(workout: ParameterizedWorkout | undefined): boolean {
  if (!workout) return false;
  return (
    workout.workoutType === 'lsd' ||
    workout.workoutType === 'long_ride' ||
    workout.durationMinutes >= 100
  );
}

function minimumExtraSessionMinutes(templateId: string): number {
  const tpl = getTemplate(templateId);
  return tpl?.fixed.minDurationMinutes ?? 30;
}

function insertScheduleWorkout(
  schedule: ScheduleResult,
  workouts: ParameterizedWorkout[],
  entry: ScheduleEntry,
  workout: ParameterizedWorkout,
): void {
  const pairs = schedule.days
    .map((day, index) => ({ day, workout: workouts[index] }))
    .concat({ day: entry, workout })
    .sort((a, b) => a.day.dayIndex - b.day.dayIndex || (a.day.slotIndex ?? 1) - (b.day.slotIndex ?? 1));
  schedule.days.splice(0, schedule.days.length, ...pairs.map((p) => p.day));
  workouts.splice(0, workouts.length, ...pairs.map((p) => p.workout));
}

function activeWeeklyMinutes(
  schedule: ScheduleResult,
  workouts: ParameterizedWorkout[],
): number {
  let total = 0;
  for (let i = 0; i < Math.min(schedule.days.length, workouts.length); i += 1) {
    const s = schedule.days[i];
    if (s.sport === 'rest' || s.sport === 'mobility') continue;
    const minutes = Number(workouts[i].durationMinutes);
    if (Number.isFinite(minutes) && minutes > 0) total += minutes;
  }
  return total;
}

function normalizeWeeklyMaxMinutes(value: number | null | undefined): number {
  if (!Number.isFinite(value ?? NaN) || !value || value <= 0) {
    return MAX_WEEKLY_TRAINING_MINUTES;
  }
  return Math.min(MAX_WEEKLY_TRAINING_MINUTES, Math.max(15, Math.round(value)));
}

function roundToFive(value: number): number {
  return Math.round(value / 5) * 5;
}

function collectViolatingDays(violations: Violation[]): number[] {
  const set = new Set<number>();
  for (const v of violations) {
    if (typeof v.dayIndex === 'number' && v.dayIndex >= 1 && v.dayIndex <= 7) {
      set.add(v.dayIndex);
    }
  }
  return Array.from(set).sort((a, b) => a - b);
}

function computeHoursSinceLatest(state: RecentState): number {
  const ts = state.latestReliableActivity?.startTimeLocal?.getTime();
  if (!ts) return Number.POSITIVE_INFINITY;
  const ms = Date.now() - ts;
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return ms / (60 * 60 * 1000);
}

function buildSummary(
  days: ScheduleEntry[],
  recentState: RecentState,
  hardCap: number,
): string {
  const sportCounts: Record<string, number> = {};
  let restCount = 0;
  let hardCount = 0;
  for (const d of days) {
    const tpl = getTemplate(d.templateId);
    const sport = tpl?.fixed.sport ?? d.sport;
    if (sport === 'rest' || sport === 'mobility') {
      restCount += 1;
      continue;
    }
    sportCounts[sport] = (sportCounts[sport] ?? 0) + 1;
    if (tpl?.fixed.intensity === 'high') hardCount += 1;
  }

  const sportPart = Object.entries(sportCounts)
    .map(([s, n]) => `${n} 次${SPORT_ZH[s] ?? s}`)
    .join(' + ');

  const fatigueZh = FATIGUE_ZH[recentState.fatigue] ?? recentState.fatigue;
  const stimulusZh = STIMULUS_ZH[recentState.latestStimulus] ?? recentState.latestStimulus;

  const parts: string[] = [];
  parts.push(
    `本周课表：${sportPart || '以休息为主'}${restCount > 0 ? `，含 ${restCount} 天恢复/休息` : ''}。`,
  );
  parts.push(
    `最新可靠训练为${stimulusZh}，疲劳${fatigueZh}。`,
  );
  parts.push(
    `本周计划 ${hardCount} 次高强度课（上限 ${hardCap}），高强度课之间间隔至少 48 小时。`,
  );
  return parts.join('');
}

function buildMonitoring(recentState: RecentState): string {
  const parts = [
    '每次训练后记录主观疲劳和睡眠质量；',
    '关注静息心率和晨起精神状态变化；',
  ];
  if (recentState.fatigue === 'tired' || recentState.fatigue === 'high_risk') {
    parts.push('若两次连续训练心率明显升高或主观疲劳持续偏高，将后续高强度课改为恢复或有氧。');
  } else {
    parts.push('每周完成度低于 70% 时下周自动下调强度，高于 90% 时考虑小幅升级。');
  }
  return parts.join('');
}

function buildAdjustmentRules(hardCap: number): string {
  return [
    `本周高强度课不超过 ${hardCap} 次；连续两天不安排高强度。`,
    '若当天主观疲劳 RPE ≥ 7/10，将主训练时长缩短 20-30%，目标心率上限降低 5-10 bpm。',
    '若发生伤病或感冒，立即将本周剩余日改为完全休息或活动恢复。',
  ].join('');
}

const SPORT_ZH: Record<string, string> = {
  running: '跑步',
  cycling: '骑行',
  swimming: '游泳',
  rest: '休息',
  mobility: '活动恢复',
  strength: '力量',
};

const FATIGUE_ZH: Record<string, string> = {
  fresh: '新鲜',
  normal: '正常',
  tired: '偏疲劳',
  high_risk: '高风险',
};

const STIMULUS_ZH: Record<string, string> = {
  recovery: '恢复课',
  aerobic: '有氧',
  long_endurance: 'LSD',
  tempo: '节奏跑',
  threshold: '阈值',
  vo2max: 'VO2max',
  anaerobic: '无氧',
  unknown: '未知',
};

// touch HARD_STIMULI to keep symbol referenced for future logic.
void HARD_STIMULI;
