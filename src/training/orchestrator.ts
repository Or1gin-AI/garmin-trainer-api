// Plan generation orchestrator (U7).
//
// Pure async function (async signature for U9 forward-compat — V1 doesn't
// await anything internal). Wires scheduler + parameterizer + validation
// together and returns a GeneratedPlan that the route handler persists and
// streams.
//
// V1 is fully deterministic: provider='deterministic', model='v1', no LLM
// calls. U9 will replace the body of this function with an LLM-driven
// version while keeping the same input/output contract.

import { buildWeeklySchedule } from './scheduler.js';
import type { ScheduleRequest, ScheduleResult, ScheduleEntry } from './scheduler.js';
import { parameterizeWorkout } from './parameterizer.js';
import type { ParameterizedWorkout } from './parameterizer.js';
import { validatePlan } from './validation.js';
import type { Violation } from './validation.js';
import type { AthleteProfile } from './athlete-profile.js';
import type { RecentState } from './recent-state.js';
import { getTemplate, type WorkoutTemplate } from './templates/index.js';

// LLM imports deferred to U9 — keep this file LLM-free.

export interface GeneratePlanInput {
  userId: string;
  request: ScheduleRequest;
  athleteProfile: AthleteProfile;
  recentState: RecentState;
}

export interface GeneratedPlan {
  schedule: ScheduleResult;
  workouts: ParameterizedWorkout[];
  violations: Violation[];
  summary: string;
  monitoring: string;
  adjustmentRules: string;
  modelMeta: {
    provider: 'deterministic';
    model: 'v1';
    totalTokens: 0;
    costCents: 0;
  };
}

const HARD_STIMULI: ReadonlySet<string> = new Set(['threshold', 'vo2max', 'anaerobic']);

export async function generatePlan(input: GeneratePlanInput): Promise<GeneratedPlan> {
  const { request, athleteProfile, recentState } = input;

  // 1) Build schedule.
  const schedule = buildWeeklySchedule({ request, athleteProfile, recentState });

  // 2) Parameterize each day.
  const workouts: ParameterizedWorkout[] = schedule.days.map((entry) =>
    parameterizeForEntry(entry, athleteProfile, recentState, request),
  );

  // 3) Validate.
  const baseCap =
    request.maxHardSessionsPerWeek ??
    (athleteProfile.experienceLevel === 'advanced' && recentState.fatigue !== 'tired'
      ? 3
      : 2);

  const hoursSinceLatest = computeHoursSinceLatest(recentState);

  let violations = validatePlan({
    schedule: schedule.days,
    workouts,
    context: {
      maxHardSessionsPerWeek: baseCap,
      hardSessionsAlreadyDoneThisWeek: 0,
      latestStimulus: recentState.latestStimulus,
      hoursSinceLatest,
      fatigue: recentState.fatigue,
    },
  });

  // 4) Single retry: try downgrading offending day's template.
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
      workouts[idx] = parameterizeForEntry(
        schedule.days[idx],
        athleteProfile,
        recentState,
        request,
      );
      mutated = true;
    }
    if (mutated) {
      violations = validatePlan({
        schedule: schedule.days,
        workouts,
        context: {
          maxHardSessionsPerWeek: baseCap,
          hardSessionsAlreadyDoneThisWeek: 0,
          latestStimulus: recentState.latestStimulus,
          hoursSinceLatest,
          fatigue: recentState.fatigue,
        },
      });
    }
  }

  // 5) Summary / monitoring / adjustment.
  const summary = buildSummary(schedule.days, recentState, baseCap);
  const monitoring = buildMonitoring(recentState);
  const adjustmentRules = buildAdjustmentRules(baseCap);

  return {
    schedule,
    workouts,
    violations,
    summary,
    monitoring,
    adjustmentRules,
    modelMeta: {
      provider: 'deterministic',
      model: 'v1',
      totalTokens: 0,
      costCents: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parameterizeForEntry(
  entry: ScheduleEntry,
  athleteProfile: AthleteProfile,
  recentState: RecentState,
  request: ScheduleRequest,
): ParameterizedWorkout {
  const tpl: WorkoutTemplate | undefined = getTemplate(entry.templateId);
  const safeTpl = tpl ?? getTemplate('rest.full.v1')!;
  const progression = decideProgression(athleteProfile, recentState, entry);
  return parameterizeWorkout({
    template: safeTpl,
    athleteProfile,
    recentState,
    request: {
      targetMetricPreference: request.targetMetricPreference,
      availableTime: request.availableTime,
    },
    scheduleEntry: entry,
    progression,
  });
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
