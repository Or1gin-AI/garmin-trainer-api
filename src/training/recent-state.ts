// deriveRecentTrainingState — pure function that turns the user's recent
// activities + per-activity quality verdicts into a snapshot of training
// state used by the scheduler and template-filter contraindications.
//
// Translated from cofounder spec "最新训练状态判断" (training-plan-generation
// -refactor.md, lines ~249-290). No I/O.

import type { NormalizedActivity } from './activity-normalizer.js';
import type { QualityResult } from './activity-quality.js';

export type Stimulus =
  | 'recovery'
  | 'aerobic'
  | 'tempo'
  | 'threshold'
  | 'vo2max'
  | 'anaerobic'
  | 'long_endurance'
  | 'unknown';

export type Fatigue = 'fresh' | 'normal' | 'tired' | 'high_risk';
export type LoadTrend = 'rising' | 'stable' | 'falling';

export interface RecentState {
  latestReliableActivity: NormalizedActivity | null;
  latestStimulus: Stimulus;
  latestTrainingLoad: number | null;
  fatigue: Fatigue;
  hardSessionsLast7d: number;
  load7d: number;
  load28d: number;
  loadTrend: LoadTrend;
  recommendation: string;
}

export interface DeriveInput {
  activities: NormalizedActivity[];
  qualities: Map<string, QualityResult>;
  asOf: Date;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HARD_STIMULI: ReadonlySet<Stimulus> = new Set([
  'threshold',
  'vo2max',
  'anaerobic',
]);

// ---------------------------------------------------------------------------
// Stimulus classifier — used both for `latestStimulus` and for counting
// hard sessions in the trailing 7-day window.
// ---------------------------------------------------------------------------

function lower(s: string | null | undefined): string {
  return (s ?? '').toLowerCase();
}

export function classifyStimulus(activity: NormalizedActivity): Stimulus {
  // Long, sustained, low/moderate-intensity sessions are their own bucket
  // regardless of TE/load — checked first because Garmin labels them
  // "Base / Aerobic" but the scheduling effect is different.
  const isLongEndurance =
    activity.durationMin >= 90 &&
    (activity.averageHr === null || activity.averageHr < 155) &&
    (activity.aerobicTrainingEffect === null ||
      activity.aerobicTrainingEffect < 4);
  if (isLongEndurance) return 'long_endurance';

  // 1) primaryBenefit / trainingEffectLabel substring match
  const labelText = `${lower(activity.primaryBenefit)} ${lower(
    activity.trainingEffectLabel,
  )}`.trim();
  if (labelText.length > 0) {
    if (labelText.includes('recovery') || labelText.includes('恢复')) {
      return 'recovery';
    }
    if (labelText.includes('anaerobic') || labelText.includes('sprint')) {
      return 'anaerobic';
    }
    if (labelText.includes('vo2')) {
      return 'vo2max';
    }
    // "Lactate Threshold" must be mapped to threshold; bare "Tempo" → tempo.
    if (labelText.includes('lactate threshold') || labelText.includes('threshold') ||
        labelText.includes('阈值')) {
      return 'threshold';
    }
    if (labelText.includes('tempo') || labelText.includes('节奏')) {
      return 'tempo';
    }
    if (
      labelText.includes('base') ||
      labelText.includes('aerobic') ||
      labelText.includes('有氧')
    ) {
      return 'aerobic';
    }
  }

  // 2) trainingLoad bucket
  if (activity.trainingLoad !== null) {
    const tl = activity.trainingLoad;
    if (tl < 20) return 'recovery';
    if (tl < 50) return 'aerobic';
    if (tl < 100) return 'tempo';
    return 'threshold';
  }

  // 3) aerobic / anaerobic TE
  const aerTE = activity.aerobicTrainingEffect;
  const anaTE = activity.anaerobicTrainingEffect;
  if (anaTE !== null && anaTE > 2) return 'anaerobic';
  if (aerTE !== null) {
    if (aerTE > 4) return 'threshold';
    if (aerTE > 3) return 'tempo';
    return 'aerobic';
  }

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

function isReliable(
  activity: NormalizedActivity,
  qualities: Map<string, QualityResult>,
): boolean {
  const q = qualities.get(activity.id);
  return q ? q.confidence !== 'low' : true;
}

export function deriveRecentTrainingState(input: DeriveInput): RecentState {
  const { activities, qualities, asOf } = input;
  const nowMs = asOf.getTime();
  const cutoff7 = nowMs - 7 * DAY_MS;
  const cutoff28 = nowMs - 28 * DAY_MS;

  // Sort newest first.
  const sorted = activities
    .filter((a): a is NormalizedActivity => Boolean(a.startTimeLocal))
    .slice()
    .sort(
      (a, b) =>
        (b.startTimeLocal?.getTime() ?? 0) -
        (a.startTimeLocal?.getTime() ?? 0),
    );

  let latestReliableActivity: NormalizedActivity | null = null;
  let latestStimulus: Stimulus = 'unknown';
  let latestTrainingLoad: number | null = null;
  let hardSessionsLast7d = 0;
  let load7d = 0;
  let load28d = 0;

  for (const a of sorted) {
    const ts = a.startTimeLocal?.getTime() ?? 0;
    const reliable = isReliable(a, qualities);
    if (!reliable) continue;

    if (latestReliableActivity === null) {
      latestReliableActivity = a;
      latestStimulus = classifyStimulus(a);
      latestTrainingLoad = a.trainingLoad;
    }

    if (ts >= cutoff28) {
      const load = a.trainingLoad ?? 0;
      load28d += load;
      if (ts >= cutoff7) {
        load7d += load;
        if (HARD_STIMULI.has(classifyStimulus(a))) {
          hardSessionsLast7d += 1;
        }
      }
    }
  }

  load7d = roundTo(load7d, 1);
  load28d = roundTo(load28d, 1);

  // Trend: compare the 7d sum to the average 7d-equivalent of the 28d sum.
  // Rising > 1.3×, falling < 0.7×, otherwise stable. If 28d is zero we treat
  // any positive 7d as 'rising' (user just started training).
  const equivalent7d = load28d / 4;
  let loadTrend: LoadTrend;
  if (equivalent7d <= 0) {
    loadTrend = load7d > 0 ? 'rising' : 'stable';
  } else if (load7d > equivalent7d * 1.3) {
    loadTrend = 'rising';
  } else if (load7d < equivalent7d * 0.7) {
    loadTrend = 'falling';
  } else {
    loadTrend = 'stable';
  }

  // Fatigue assessment.
  const hoursSinceLatest =
    latestReliableActivity?.startTimeLocal != null
      ? (nowMs - latestReliableActivity.startTimeLocal.getTime()) / HOUR_MS
      : Infinity;

  let fatigue: Fatigue;
  if (
    hardSessionsLast7d >= 3 ||
    (loadTrend === 'rising' && load7d > 1.5 * equivalent7d && load28d > 0)
  ) {
    fatigue = 'high_risk';
  } else if (
    hardSessionsLast7d >= 2 ||
    (HARD_STIMULI.has(latestStimulus) && hoursSinceLatest <= 36)
  ) {
    fatigue = 'tired';
  } else if (
    load28d > 0 &&
    load7d < 0.5 * equivalent7d &&
    hoursSinceLatest > 5 * 24
  ) {
    fatigue = 'fresh';
  } else {
    fatigue = 'normal';
  }

  const recommendation = buildRecommendation({
    latestReliableActivity,
    latestStimulus,
    latestTrainingLoad,
    hoursSinceLatest,
    load7d,
    load28d,
    loadTrend,
    fatigue,
    hardSessionsLast7d,
  });

  return {
    latestReliableActivity,
    latestStimulus,
    latestTrainingLoad,
    fatigue,
    hardSessionsLast7d,
    load7d,
    load28d,
    loadTrend,
    recommendation,
  };
}

// ---------------------------------------------------------------------------
// Recommendation string — concise Chinese summary, ≤ 240 chars.
// ---------------------------------------------------------------------------

interface RecommendationInput {
  latestReliableActivity: NormalizedActivity | null;
  latestStimulus: Stimulus;
  latestTrainingLoad: number | null;
  hoursSinceLatest: number;
  load7d: number;
  load28d: number;
  loadTrend: LoadTrend;
  fatigue: Fatigue;
  hardSessionsLast7d: number;
}

const STIMULUS_ZH: Record<Stimulus, string> = {
  recovery: '恢复课',
  aerobic: '有氧',
  tempo: '节奏跑',
  threshold: '阈值',
  vo2max: 'VO2max',
  anaerobic: '无氧',
  long_endurance: 'LSD',
  unknown: '未知强度',
};

const FATIGUE_ZH: Record<Fatigue, string> = {
  fresh: '状态新鲜',
  normal: '负荷正常',
  tired: '已有疲劳',
  high_risk: '过度训练风险',
};

const TREND_ZH: Record<LoadTrend, string> = {
  rising: '上升',
  stable: '平稳',
  falling: '下降',
};

function buildRecommendation(input: RecommendationInput): string {
  if (!input.latestReliableActivity) {
    return '暂无可靠的近期活动数据，建议从轻松有氧或恢复课开始，逐步建立基线。';
  }

  const parts: string[] = [];
  const stimulusLabel = STIMULUS_ZH[input.latestStimulus];
  const loadPart =
    input.latestTrainingLoad !== null
      ? `${Math.round(input.latestTrainingLoad)} TL`
      : '负荷未记录';
  const hoursAgo = Math.max(0, Math.round(input.hoursSinceLatest));
  const timePart =
    hoursAgo < 24 ? `${hoursAgo} 小时前` : `${Math.round(hoursAgo / 24)} 天前`;
  parts.push(`最近可靠训练为${stimulusLabel}（${loadPart}，${timePart}）`);

  parts.push(
    `7 天负荷 ${input.load7d}，28 天 ${input.load28d}，趋势${TREND_ZH[input.loadTrend]}`,
  );

  parts.push(FATIGUE_ZH[input.fatigue]);

  if (HARD_STIMULI.has(input.latestStimulus) && hoursAgo < 36) {
    parts.push('下一次质量课至少推迟 24 小时');
  } else if (input.fatigue === 'high_risk') {
    parts.push('建议本周以恢复和低强度有氧为主');
  } else if (input.fatigue === 'tired') {
    parts.push('建议先做一次恢复或轻松有氧课');
  } else if (input.hardSessionsLast7d >= 2) {
    parts.push('本周高强度课已达 2 次，剩余安排以有氧为主');
  }

  let out = parts.join('；') + '。';
  if (out.length > 240) out = out.slice(0, 237) + '…';
  return out;
}

function roundTo(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
