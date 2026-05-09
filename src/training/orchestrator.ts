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

import { buildWeeklySchedule } from './scheduler.js';
import type { ScheduleRequest, ScheduleResult, ScheduleEntry } from './scheduler.js';
import { parameterizeWorkout } from './parameterizer.js';
import type { ParameterizedWorkout } from './parameterizer.js';
import { validatePlan } from './validation.js';
import type { Violation } from './validation.js';
import type { AthleteProfile } from './athlete-profile.js';
import type { RecentState } from './recent-state.js';
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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GeneratePlanInput {
  userId: string;
  request: ScheduleRequest;
  athleteProfile: AthleteProfile;
  recentState: RecentState;
  signal?: AbortSignal;
  onSummaryDelta?: (delta: { kind: SummaryDeltaKind; text: string }) => void;
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
  const { request, athleteProfile, recentState, signal } = input;

  // Stage 1: schedule.
  const stageOne = await runScheduleStage({
    request,
    athleteProfile,
    recentState,
    signal,
  });
  const schedule = stageOne.schedule;

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
    const progression = decideProgression(athleteProfile, recentState, entry);
    const tplResolved: WorkoutTemplate = tpl;

    // Skip LLM for rest/mobility — they're trivially deterministic and the
    // model would just fill in zeros.
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
          },
          scheduleEntry: entry,
          progression,
        }),
      );
      fallbackParamCount += 1;
      continue;
    }

    try {
      const llmRes = await llmParameterizeWorkout({
        template: tplResolved,
        athleteProfile,
        recentState,
        request: {
          targetMetricPreference: request.targetMetricPreference,
          availableTime: request.availableTime,
        },
        scheduleEntry: entry,
        progression,
        signal,
      });
      workouts.push({
        ...llmRes.workout,
        parameterSource: {
          ...llmRes.workout.parameterSource,
          replacedVariables: {
            ...llmRes.workout.parameterSource.replacedVariables,
            __source: 'llm',
          },
        },
      });
      totalInputTokens += llmRes.meta.inputTokens;
      totalOutputTokens += llmRes.meta.outputTokens;
      llmParamCount += 1;
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
      workouts.push(
        parameterizeWorkout({
          template: tplResolved,
          athleteProfile,
          recentState,
          request: {
            targetMetricPreference: request.targetMetricPreference,
            availableTime: request.availableTime,
          },
          scheduleEntry: entry,
          progression,
        }),
      );
      fallbackParamCount += 1;
    }
  }

  // Stage 3: validate + retry-with-downgrade.
  const baseCap = computeBaseCap(request, athleteProfile, recentState);
  const hoursSinceLatest = computeHoursSinceLatest(recentState);

  let violations = validatePlan({
    schedule: schedule.days,
    workouts,
    context: {
      maxHardSessionsPerWeek: baseCap,
      hardSessionsAlreadyDoneThisWeek: recentState.hardSessionsLast7d,
      latestStimulus: recentState.latestStimulus,
      hoursSinceLatest,
      fatigue: recentState.fatigue,
    },
  });

  if (violations.length > 0) {
    const dayIndexes = collectViolatingDays(violations);
    let mutated = false;
    for (const dayIndex of dayIndexes) {
      const idx = dayIndex - 1;
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
        },
        scheduleEntry: schedule.days[idx],
        progression: decideProgression(athleteProfile, recentState, schedule.days[idx]),
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
        },
      });
    }
  }

  // Stage 4: summary.
  const summaryStage = await runSummaryStage({
    schedule,
    workouts,
    request,
    athleteProfile,
    recentState,
    signal,
    onDelta: input.onSummaryDelta,
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
  signal?: AbortSignal;
}): Promise<ScheduleStageResult> {
  const { request, athleteProfile, recentState, signal } = args;

  let firstViolations: string[] | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    try {
      const res = await llmBuildWeeklySchedule({
        request,
        athleteProfile,
        recentState,
        signal,
        retryViolations: firstViolations ?? undefined,
      });
      return { schedule: res.schedule, source: 'llm', meta: res.meta };
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

  return {
    schedule: buildWeeklySchedule({ request, athleteProfile, recentState }),
    source: 'deterministic',
  };
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
  signal?: AbortSignal;
  onDelta?: (delta: { kind: SummaryDeltaKind; text: string }) => void;
}): Promise<SummaryStageResult> {
  const { schedule, workouts, request, athleteProfile, recentState, signal } = args;
  const baseCap = computeBaseCap(request, athleteProfile, recentState);

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
): number {
  return (
    request.maxHardSessionsPerWeek ??
    (athleteProfile.experienceLevel === 'advanced' && recentState.fatigue !== 'tired'
      ? 3
      : 2)
  );
}

function decideProgression(
  athleteProfile: AthleteProfile,
  recentState: RecentState,
  entry: ScheduleEntry,
): 'conservative' | 'normal' | 'aggressive' {
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
    recentState.fatigue === 'fresh' &&
    athleteProfile.experienceLevel === 'advanced'
  ) {
    return 'aggressive';
  }
  return 'normal';
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
