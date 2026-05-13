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

import {
  applyDurationCap,
  buildWeeklySchedule,
  MAX_WEEKLY_TRAINING_MINUTES,
  requestedDoubleDayIndex,
} from './scheduler.js';
import type { ScheduleRequest, ScheduleResult, ScheduleEntry } from './scheduler.js';
import { parameterizeWorkout } from './parameterizer.js';
import type { ParameterizedWorkout } from './parameterizer.js';
import { validatePlan } from './validation.js';
import type { Violation } from './validation.js';
import type { AthleteProfile } from './athlete-profile.js';
import type { RecentState } from './recent-state.js';
import type { TrainingCapacity } from './training-capacity.js';
import { getTemplate, type WorkoutTemplate } from './templates/index.js';
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
  TOOL_DISPLAY,
  dayDisplay,
  summarizeParameterized,
  summarizeValidation,
  summarizeSchedule,
} from './tool-event-labels.js';
import type { ToolEventPayload } from '../lib/sse.js';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GeneratePlanInput {
  userId: string;
  request: ScheduleRequest;
  athleteProfile: AthleteProfile;
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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function generatePlan(input: GeneratePlanInput): Promise<GeneratedPlan> {
  const { request, athleteProfile, recentState, trainingCapacity, signal, onToolEvent } = input;
  const emit = onToolEvent ?? (() => {});

  // Stage 1: schedule.
  const stageOne = await runScheduleStage({
    request,
    athleteProfile,
    recentState,
    trainingCapacity,
    signal,
    emit,
  });
  let schedule = stageOne.schedule;
  const progressionCapacity = request.forceRequestedSchedule ? undefined : trainingCapacity;
  schedule = expandMultiSessionSchedule(
    schedule,
    request,
    athleteProfile,
    recentState,
    trainingCapacity,
  );

  let totalInputTokens = stageOne.meta?.inputTokens ?? 0;
  let totalOutputTokens = stageOne.meta?.outputTokens ?? 0;
  const provider = stageOne.meta?.provider ?? DETERMINISTIC_PROVIDER;
  const model = stageOne.meta?.model ?? DETERMINISTIC_MODEL;

  // Stage 2: parameterize each day.
  let llmParamCount = 0;
  let fallbackParamCount = 0;
  const workouts: ParameterizedWorkout[] = [];

  for (const entry of schedule.days) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const tpl = getTemplate(entry.templateId) ?? getTemplate('rest.full.v1');
    if (!tpl) {
      // Should never happen — both rest templates are baked in.
      throw new Error(`Missing template ${entry.templateId} and no rest fallback`);
    }
    const progression = decideProgression(athleteProfile, recentState, entry, progressionCapacity);
    const tplResolved: WorkoutTemplate = tpl;

    // Skip LLM for rest/mobility — they're trivially deterministic and the
    // model would just fill in zeros. We don't emit a tool_event for these
    // either: they'd just be noise.
    const isRest = tplResolved.fixed.sport === 'rest' || tplResolved.fixed.sport === 'mobility';
    if (isRest) {
      workouts.push(
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
        }),
      );
      fallbackParamCount += 1;
      continue;
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
        signal,
      });
      const w = {
        ...llmRes.workout,
        parameterSource: {
          ...llmRes.workout.parameterSource,
          replacedVariables: {
            ...llmRes.workout.parameterSource.replacedVariables,
            __source: 'llm',
          },
        },
      };
      workouts.push(w);
      totalInputTokens += llmRes.meta.inputTokens;
      totalOutputTokens += llmRes.meta.outputTokens;
      llmParamCount += 1;
      emit({
        id: paramId,
        name: 'llm_parameterize_workout',
        displayName: paramDisplay,
        phase: 'done',
        summary: summarizeParameterized('llm', w),
        durationMs: Date.now() - paramStart,
      });
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
      const fallbackW = parameterizeWorkout({
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
      workouts.push(fallbackW);
      fallbackParamCount += 1;
      emit({
        id: paramId,
        name: 'llm_parameterize_workout',
        displayName: paramDisplay,
        phase: 'done',
        summary: summarizeParameterized('fallback', fallbackW),
        durationMs: Date.now() - paramStart,
      });
    }
  }

  enforceWeeklyDurationLimit(schedule, workouts, request);

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

  if (violations.length > 0) {
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
      violations = validatePlan({
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
    },
  };
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
    /双阈值|double\s*threshold/i.test(`${request.goal ?? ''}\n${request.notes ?? ''}`);
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
  recentState: RecentState;
  trainingCapacity?: TrainingCapacity;
  signal?: AbortSignal;
  emit: (e: ToolEventPayload) => void;
}): Promise<ScheduleStageResult> {
  const { request, athleteProfile, recentState, trainingCapacity, signal, emit } = args;

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
        if (attempt === 0) {
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
    workouts[candidate.index] = adjustWorkoutDuration(
      workouts[candidate.index],
      nextMinutes,
      limit,
    );
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

function adjustWorkoutDuration(
  workout: ParameterizedWorkout,
  nextMinutes: number,
  weeklyLimit: number,
): ParameterizedWorkout {
  const current = workout.durationMinutes;
  const durationMinutes = Math.max(0, Math.round(nextMinutes));
  if (durationMinutes === current) return workout;
  const scale =
    current > 0 && workout.distanceKm !== null
      ? durationMinutes / current
      : null;
  const distanceKm =
    scale && Number.isFinite(scale)
      ? Math.round(workout.distanceKm! * scale * 100) / 100
      : workout.distanceKm;
  const targets = [
    `总时长 ${durationMinutes} 分钟（已按周上限 ${weeklyLimit} 分钟控制）`,
    ...(workout.targets ?? []).filter((t) => !/^总时长\s*\d+\s*分钟/.test(t)),
  ];
  return {
    ...workout,
    durationMinutes,
    distanceKm,
    targets,
    parameterSource: {
      ...workout.parameterSource,
      replacedVariables: {
        ...workout.parameterSource.replacedVariables,
        __weekly_duration_limit: weeklyLimit,
        __original_duration_minutes: current,
      },
    },
  };
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
