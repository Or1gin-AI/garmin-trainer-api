import type { QualityResult } from './activity-quality.js';
import type { NormalizedActivity, NormalizedSport } from './activity-normalizer.js';
import { classifyStimulus, type Stimulus } from './recent-state.js';
import { getTemplate } from './templates/index.js';
import type { Sport } from './templates/types.js';

export type CapacitySport = 'running' | 'cycling' | 'swimming';
export type CapacityLevel = 'novice' | 'developing' | 'trained' | 'advanced';
export type CapacityReadiness = 'green' | 'yellow' | 'red';
export type CapacityConfidence = 'low' | 'medium' | 'high';

export interface LoadBlock {
  minutes: number;
  load: number;
  sessions: number;
}

export interface SportCapacity {
  available: boolean;
  confidence: CapacityConfidence;
  recent: {
    sessions28d: number;
    sessions56d: number;
    minutes28d: number;
    minutes56d: number;
    load28d: number;
    distance28d: number | null;
  };
  durability: {
    longestRecentMinutes: number | null;
    p80SessionMinutes: number | null;
    p90SessionMinutes: number | null;
    safeSessionMinutes: number;
    safeLongSessionMinutes: number;
  };
  intensity: {
    lowMinutesShare: number | null;
    moderateMinutesShare: number | null;
    highMinutesShare: number | null;
    hardSessions7d: number;
    hardSessions28d: number;
  };
  limiters: string[];
}

export interface TrainingCapacity {
  generatedAt: string;
  lookbackDays: number;
  overall: {
    level: CapacityLevel;
    readiness: CapacityReadiness;
    readinessConfidence: CapacityConfidence;
    risk: 'low' | 'moderate' | 'high';
    reasons: string[];
  };
  load: {
    acute7d: LoadBlock;
    chronic28d: LoadBlock;
    chronic56d: LoadBlock;
    acuteChronicRatio: number | null;
    monotony: number | null;
    strain: number | null;
  };
  recovery: {
    sleepRisk: 'low' | 'moderate' | 'high' | 'unknown';
    hrvRisk: 'low' | 'moderate' | 'high' | 'unknown';
    trainingStatusRisk: 'low' | 'moderate' | 'high' | 'unknown';
    recoveryTimeRisk: 'low' | 'moderate' | 'high' | 'unknown';
    latestSleepScore: number | null;
    latestHrvStatus: string | null;
    latestTrainingStatus: string | null;
    latestRecoveryTimeHours: number | null;
  };
  sports: Record<CapacitySport, SportCapacity>;
  guardrails: {
    maxHardSessionsPerWeek: number;
    maxHighMinutesShare: number;
    minLowMinutesShare: number;
    allowHighIntensity: boolean;
    allowDoubleDays: boolean;
    maxSessionMinutes: Record<CapacitySport, number>;
    maxLongSessionMinutes: Record<CapacitySport, number>;
    notes: string[];
  };
}

export interface DeriveTrainingCapacityInput {
  activities: NormalizedActivity[];
  qualities: Map<string, QualityResult>;
  asOf: Date;
  lookbackDays?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SPORTS: CapacitySport[] = ['running', 'cycling', 'swimming'];
const HARD_STIMULI: ReadonlySet<Stimulus> = new Set(['threshold', 'vo2max', 'anaerobic']);

const DEFAULT_SESSION_CAP: Record<CapacityLevel, Record<CapacitySport, number>> = {
  novice: { running: 45, cycling: 75, swimming: 45 },
  developing: { running: 60, cycling: 90, swimming: 55 },
  trained: { running: 75, cycling: 120, swimming: 65 },
  advanced: { running: 90, cycling: 150, swimming: 75 },
};

const DEFAULT_LONG_CAP: Record<CapacityLevel, Record<CapacitySport, number>> = {
  novice: { running: 60, cycling: 90, swimming: 50 },
  developing: { running: 75, cycling: 120, swimming: 60 },
  trained: { running: 95, cycling: 165, swimming: 75 },
  advanced: { running: 115, cycling: 210, swimming: 90 },
};

export function deriveTrainingCapacity(input: DeriveTrainingCapacityInput): TrainingCapacity {
  const lookbackDays = input.lookbackDays ?? 56;
  const asOfMs = input.asOf.getTime();
  const reliable = input.activities
    .filter((a) => isReliable(a, input.qualities))
    .filter((a) => withinDays(a, lookbackDays, asOfMs));

  const acute7d = summarizeWindow(reliable, asOfMs, 7);
  const chronic28d = summarizeWindow(reliable, asOfMs, 28);
  const chronic56d = summarizeWindow(reliable, asOfMs, 56);
  const dailyLoads = buildDailyLoads(reliable, asOfMs, 7);
  const monotony = computeMonotony(dailyLoads);
  const strain = monotony === null ? null : roundTo(sum(dailyLoads) * monotony, 1);
  const acuteChronicRatio =
    chronic28d.load > 0 ? roundTo(acute7d.load / (chronic28d.load / 4), 2) : null;

  const level = deriveCapacityLevel(reliable);
  const sports = Object.fromEntries(
    SPORTS.map((sport) => [sport, deriveSportCapacity(sport, reliable, input.qualities, asOfMs, level)]),
  ) as Record<CapacitySport, SportCapacity>;
  const recovery = deriveRecoveryCapacity(reliable, asOfMs);
  const overall = deriveOverallCapacity({
    level,
    acuteChronicRatio,
    monotony,
    recovery,
    acute7d,
    chronic28d,
  });
  const guardrails = deriveGuardrails(overall, sports);

  return {
    generatedAt: input.asOf.toISOString(),
    lookbackDays,
    overall,
    load: {
      acute7d,
      chronic28d,
      chronic56d,
      acuteChronicRatio,
      monotony,
      strain,
    },
    recovery,
    sports,
    guardrails,
  };
}

export function getCapacityDurationCap(
  capacity: TrainingCapacity | undefined,
  sport: Sport,
  templateId: string,
): { minutes: number; reason: string } | null {
  if (!capacity || !isCapacitySport(sport)) return null;
  const tpl = getTemplate(templateId);
  if (!tpl) return null;
  const caps = capacity.guardrails;
  const isLong =
    tpl.fixed.workoutType === 'lsd' ||
    tpl.fixed.workoutType === 'long_ride' ||
    templateId === 'run.lsd.v1' ||
    templateId === 'bike.long_ride.v1';
  const minutes = isLong
    ? caps.maxLongSessionMinutes[sport]
    : caps.maxSessionMinutes[sport];
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return {
    minutes: Math.round(minutes),
    reason: isLong ? '历史长课容量上限' : '历史单次训练容量上限',
  };
}

function deriveOverallCapacity(args: {
  level: CapacityLevel;
  acuteChronicRatio: number | null;
  monotony: number | null;
  recovery: TrainingCapacity['recovery'];
  acute7d: LoadBlock;
  chronic28d: LoadBlock;
}): TrainingCapacity['overall'] {
  const reasons: string[] = [];
  let score = 0;

  if (args.acuteChronicRatio !== null && args.acuteChronicRatio > 1.5) {
    score += 2;
    reasons.push(`7 天负荷约为 28 天周均的 ${args.acuteChronicRatio} 倍`);
  } else if (args.acuteChronicRatio !== null && args.acuteChronicRatio > 1.3) {
    score += 1;
    reasons.push(`近期负荷上升（ACWR ${args.acuteChronicRatio}）`);
  }

  if (args.monotony !== null && args.monotony > 2.5 && args.acute7d.load > 0) {
    score += 2;
    reasons.push(`训练单调性偏高（${args.monotony}）`);
  } else if (args.monotony !== null && args.monotony > 2.0 && args.acute7d.load > 0) {
    score += 1;
    reasons.push(`训练单调性升高（${args.monotony}）`);
  }

  for (const [label, risk] of [
    ['睡眠', args.recovery.sleepRisk],
    ['HRV', args.recovery.hrvRisk],
    ['Garmin 训练状态', args.recovery.trainingStatusRisk],
    ['恢复时间', args.recovery.recoveryTimeRisk],
  ] as const) {
    if (risk === 'high') {
      score += 2;
      reasons.push(`${label}提示恢复风险高`);
    } else if (risk === 'moderate') {
      score += 1;
      reasons.push(`${label}提示恢复风险中等`);
    }
  }

  const availableRecoverySignals = [
    args.recovery.sleepRisk,
    args.recovery.hrvRisk,
    args.recovery.trainingStatusRisk,
    args.recovery.recoveryTimeRisk,
  ].filter((r) => r !== 'unknown').length;

  const readiness: CapacityReadiness = score >= 4 ? 'red' : score >= 2 ? 'yellow' : 'green';
  const risk = readiness === 'red' ? 'high' : readiness === 'yellow' ? 'moderate' : 'low';
  const readinessConfidence: CapacityConfidence =
    args.acute7d.sessions > 0 && availableRecoverySignals >= 2
      ? 'high'
      : args.acute7d.sessions > 0 || availableRecoverySignals >= 1
        ? 'medium'
        : 'low';

  if (reasons.length === 0) {
    reasons.push('近期负荷与恢复信号未触发保护规则');
  }

  return {
    level: args.level,
    readiness,
    readinessConfidence,
    risk,
    reasons,
  };
}

function deriveGuardrails(
  overall: TrainingCapacity['overall'],
  sports: Record<CapacitySport, SportCapacity>,
): TrainingCapacity['guardrails'] {
  let maxHardSessionsPerWeek = maxHardSessionsByLevel(overall.level);
  if (
    overall.level === 'advanced' &&
    overall.readiness === 'green' &&
    overall.readinessConfidence === 'high'
  ) {
    maxHardSessionsPerWeek = 3;
  }
  if (overall.readiness === 'yellow') {
    maxHardSessionsPerWeek = Math.min(maxHardSessionsPerWeek, 1);
  }
  if (overall.readiness === 'red' || overall.readinessConfidence === 'low') {
    maxHardSessionsPerWeek = 0;
  }

  const allowHighIntensity = maxHardSessionsPerWeek > 0;
  const intensityBounds = intensityDistributionBounds(overall.level, overall.readiness);
  const allowDoubleDays =
    overall.level === 'advanced' &&
    overall.readiness === 'green' &&
    overall.readinessConfidence !== 'low';

  const maxSessionMinutes = fromSports((sport) => sports[sport].durability.safeSessionMinutes);
  const maxLongSessionMinutes = fromSports((sport) => sports[sport].durability.safeLongSessionMinutes);
  const notes: string[] = [
    `训练容量评估：${overall.level}，恢复状态 ${overall.readiness}，高强度上限 ${maxHardSessionsPerWeek} 次。`,
    `强度分布保护：高强度分钟不超过本周训练分钟的 ${Math.round(intensityBounds.maxHighMinutesShare * 100)}%，低强度分钟目标不低于 ${Math.round(intensityBounds.minLowMinutesShare * 100)}%。`,
  ];
  if (!allowHighIntensity) {
    notes.push('恢复或数据置信度不足，本周不自动安排高强度课。');
  }
  if (!allowDoubleDays) {
    notes.push('未满足高级且恢复良好的条件，本周不自动安排同日两练。');
  }

  return {
    maxHardSessionsPerWeek,
    maxHighMinutesShare: intensityBounds.maxHighMinutesShare,
    minLowMinutesShare: intensityBounds.minLowMinutesShare,
    allowHighIntensity,
    allowDoubleDays,
    maxSessionMinutes,
    maxLongSessionMinutes,
    notes,
  };
}

function maxHardSessionsByLevel(level: CapacityLevel): number {
  if (level === 'advanced') return 2;
  if (level === 'trained') return 2;
  if (level === 'developing') return 1;
  return 1;
}

function intensityDistributionBounds(
  level: CapacityLevel,
  readiness: CapacityReadiness,
): { maxHighMinutesShare: number; minLowMinutesShare: number } {
  if (readiness === 'red') {
    return { maxHighMinutesShare: 0, minLowMinutesShare: 0.9 };
  }

  const base =
    level === 'advanced'
      ? { maxHighMinutesShare: 0.15, minLowMinutesShare: 0.7 }
      : level === 'trained'
        ? { maxHighMinutesShare: 0.12, minLowMinutesShare: 0.7 }
        : level === 'developing'
          ? { maxHighMinutesShare: 0.08, minLowMinutesShare: 0.75 }
          : { maxHighMinutesShare: 0.05, minLowMinutesShare: 0.8 };

  if (readiness === 'yellow') {
    return {
      maxHighMinutesShare: Math.min(base.maxHighMinutesShare, 0.05),
      minLowMinutesShare: Math.max(base.minLowMinutesShare, 0.8),
    };
  }
  return base;
}

function deriveSportCapacity(
  sport: CapacitySport,
  activities: NormalizedActivity[],
  qualities: Map<string, QualityResult>,
  asOfMs: number,
  level: CapacityLevel,
): SportCapacity {
  const sportActivities = activities
    .filter((a) => a.sport === sport)
    .sort((a, b) => (a.startTimeLocal?.getTime() ?? 0) - (b.startTimeLocal?.getTime() ?? 0));
  const last28 = sportActivities.filter((a) => withinDays(a, 28, asOfMs));
  const durations = sportActivities
    .map((a) => a.durationMin)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  const durations28 = last28
    .map((a) => a.durationMin)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  const longest = durations.length > 0 ? durations[durations.length - 1] : null;
  const p80 = percentile(durations, 0.8);
  const p90 = percentile(durations, 0.9);
  const minutes28 = roundTo(sum(last28.map((a) => a.durationMin)), 1);
  const minutes56 = roundTo(sum(sportActivities.map((a) => a.durationMin)), 1);
  const load28 = roundTo(sum(last28.map(activityLoad)), 1);
  const distance28Raw = sum(last28.map((a) => a.distanceKm));
  const distance28 = distance28Raw > 0 ? roundTo(distance28Raw, 1) : null;
  const hardSessions7d = sportActivities.filter(
    (a) => withinDays(a, 7, asOfMs) && HARD_STIMULI.has(classifyStimulus(a)),
  ).length;
  const hardSessions28d = last28.filter((a) => HARD_STIMULI.has(classifyStimulus(a))).length;

  const intensityMinutes = { low: 0, moderate: 0, high: 0 };
  for (const activity of last28) {
    const bucket = intensityBucket(classifyStimulus(activity));
    intensityMinutes[bucket] += activity.durationMin;
  }
  const intensityTotal =
    intensityMinutes.low + intensityMinutes.moderate + intensityMinutes.high;

  const confidence = deriveSportConfidence(sport, sportActivities, qualities);
  const safeSessionMinutes = deriveSafeSessionMinutes(sport, level, durations28);
  const safeLongSessionMinutes = deriveSafeLongSessionMinutes(
    sport,
    level,
    durations28,
    minutes28 / 4,
  );
  const limiters: string[] = [];
  if (confidence === 'low') limiters.push('该项目近期可靠数据不足');
  if (hardSessions7d >= 2) limiters.push('该项目近 7 天高强度次数偏多');

  return {
    available: sportActivities.length > 0,
    confidence,
    recent: {
      sessions28d: last28.length,
      sessions56d: sportActivities.length,
      minutes28d: minutes28,
      minutes56d: minutes56,
      load28d: load28,
      distance28d: distance28,
    },
    durability: {
      longestRecentMinutes: longest === null ? null : Math.round(longest),
      p80SessionMinutes: p80 === null ? null : Math.round(p80),
      p90SessionMinutes: p90 === null ? null : Math.round(p90),
      safeSessionMinutes,
      safeLongSessionMinutes,
    },
    intensity: {
      lowMinutesShare: share(intensityMinutes.low, intensityTotal),
      moderateMinutesShare: share(intensityMinutes.moderate, intensityTotal),
      highMinutesShare: share(intensityMinutes.high, intensityTotal),
      hardSessions7d,
      hardSessions28d,
    },
    limiters,
  };
}

function deriveSafeSessionMinutes(
  sport: CapacitySport,
  level: CapacityLevel,
  recentDurations: number[],
): number {
  const fallback = DEFAULT_SESSION_CAP[level][sport];
  const p90 = percentile(recentDurations, 0.9);
  if (p90 === null) return fallback;
  const multiplier = sport === 'running' ? 1.1 : sport === 'cycling' ? 1.15 : 1.1;
  const cap = Math.max(fallback * 0.75, p90 * multiplier);
  return Math.round(Math.min(DEFAULT_LONG_CAP[level][sport], cap));
}

function deriveSafeLongSessionMinutes(
  sport: CapacitySport,
  level: CapacityLevel,
  recentDurations: number[],
  chronicWeeklyMinutes: number,
): number {
  const fallback = DEFAULT_LONG_CAP[level][sport];
  const p90 = percentile(recentDurations, 0.9);
  const longest = recentDurations.length > 0 ? recentDurations[recentDurations.length - 1] : null;
  if (p90 === null || longest === null) return fallback;

  const sportMultiplier = sport === 'running' ? 1.15 : sport === 'cycling' ? 1.25 : 1.15;
  const longestMultiplier = sport === 'running' ? 1.1 : sport === 'cycling' ? 1.2 : 1.1;
  const shareCap = longSessionShareCap(sport, level);
  const candidates = [
    p90 * sportMultiplier,
    longest * longestMultiplier,
    DEFAULT_LONG_CAP[level][sport],
  ];
  if (chronicWeeklyMinutes >= 90) {
    candidates.push(Math.max(fallback * 0.75, chronicWeeklyMinutes * shareCap));
  }
  return Math.round(Math.max(30, Math.min(...candidates)));
}

function deriveCapacityLevel(activities: NormalizedActivity[]): CapacityLevel {
  const sessions56 = activities.length;
  const minutes56 = sum(activities.map((a) => a.durationMin));
  const weeklyMinutes = minutes56 / 8;
  const activeSports = new Set(activities.map((a) => a.sport).filter(isNormalizedCapacitySport)).size;

  if (sessions56 >= 32 && weeklyMinutes >= 360 && activeSports >= 1) return 'advanced';
  if (sessions56 >= 18 && weeklyMinutes >= 210) return 'trained';
  if (sessions56 >= 6 && weeklyMinutes >= 90) return 'developing';
  return 'novice';
}

function deriveRecoveryCapacity(
  activities: NormalizedActivity[],
  asOfMs: number,
): TrainingCapacity['recovery'] {
  const latestSleepScore = latestNumber(activities, (a) => a.sleepScore);
  const latestHrvStatus = latestString(activities, (a) => a.hrvStatus);
  const latestTrainingStatus = latestString(activities, (a) => a.trainingStatus);
  const latestRecoveryTimeHours = latestNumber(activities, (a) => a.recoveryTimeHours);

  return {
    sleepRisk: sleepRisk(latestSleepScore),
    hrvRisk: hrvRisk(latestHrvStatus),
    trainingStatusRisk: trainingStatusRisk(latestTrainingStatus),
    recoveryTimeRisk: recoveryTimeRisk(latestRecoveryTimeHours),
    latestSleepScore,
    latestHrvStatus,
    latestTrainingStatus,
    latestRecoveryTimeHours,
  };

  function latestNumber(
    source: NormalizedActivity[],
    read: (activity: NormalizedActivity) => number | null,
  ): number | null {
    const hit = latestActivityWith(source, (a) => read(a) !== null && withinDays(a, 7, asOfMs));
    if (!hit) return null;
    const value = read(hit);
    return value !== null && Number.isFinite(value) ? value : null;
  }

  function latestString(
    source: NormalizedActivity[],
    read: (activity: NormalizedActivity) => string | null,
  ): string | null {
    const hit = latestActivityWith(source, (a) => Boolean(read(a)) && withinDays(a, 14, asOfMs));
    return hit ? read(hit) : null;
  }
}

function deriveSportConfidence(
  sport: CapacitySport,
  activities: NormalizedActivity[],
  qualities: Map<string, QualityResult>,
): CapacityConfidence {
  if (activities.length < 3) return 'low';
  const reliableCount = activities.filter((a) => isReliable(a, qualities)).length;
  const physiologicalCount = activities.filter(hasPhysiologicalSignal).length;
  const ratio = reliableCount > 0 ? physiologicalCount / reliableCount : 0;
  if (activities.length >= 8 && ratio >= 0.7) return 'high';
  if (activities.length >= 3 && ratio >= 0.4) return 'medium';
  if (sport === 'swimming' && activities.length >= 4) return 'medium';
  return 'low';
}

function summarizeWindow(activities: NormalizedActivity[], asOfMs: number, days: number): LoadBlock {
  const selected = activities.filter((a) => withinDays(a, days, asOfMs));
  return {
    minutes: roundTo(sum(selected.map((a) => a.durationMin)), 1),
    load: roundTo(sum(selected.map(activityLoad)), 1),
    sessions: selected.length,
  };
}

function buildDailyLoads(activities: NormalizedActivity[], asOfMs: number, days: number): number[] {
  const loads = new Array(days).fill(0) as number[];
  for (const activity of activities) {
    const ts = activity.startTimeLocal?.getTime();
    if (!ts) continue;
    const ageDays = Math.floor((asOfMs - ts) / DAY_MS);
    if (ageDays < 0 || ageDays >= days) continue;
    loads[days - 1 - ageDays] += activityLoad(activity);
  }
  return loads.map((n) => roundTo(n, 1));
}

function activityLoad(activity: NormalizedActivity): number {
  if (activity.trainingLoad !== null && Number.isFinite(activity.trainingLoad)) {
    return Math.max(0, activity.trainingLoad);
  }
  return Math.max(0, activity.durationMin) * intensityWeight(classifyStimulus(activity));
}

function intensityWeight(stimulus: Stimulus): number {
  if (stimulus === 'recovery') return 0.5;
  if (stimulus === 'aerobic') return 1;
  if (stimulus === 'long_endurance') return 1.4;
  if (stimulus === 'tempo') return 2;
  if (HARD_STIMULI.has(stimulus)) return 3;
  return 1;
}

function intensityBucket(stimulus: Stimulus): 'low' | 'moderate' | 'high' {
  if (stimulus === 'tempo') return 'moderate';
  if (HARD_STIMULI.has(stimulus)) return 'high';
  return 'low';
}

function sleepRisk(score: number | null): TrainingCapacity['recovery']['sleepRisk'] {
  if (score === null) return 'unknown';
  if (score >= 80) return 'low';
  if (score >= 60) return 'moderate';
  return 'high';
}

function hrvRisk(status: string | null): TrainingCapacity['recovery']['hrvRisk'] {
  if (!status) return 'unknown';
  const normalized = status.toLowerCase();
  if (normalized.includes('unbalanced')) return 'moderate';
  if (normalized.includes('low') || normalized.includes('poor')) return 'high';
  if (normalized.includes('balanced')) return 'low';
  if (normalized.includes('no')) return 'unknown';
  return 'unknown';
}

function trainingStatusRisk(status: string | null): TrainingCapacity['recovery']['trainingStatusRisk'] {
  if (!status) return 'unknown';
  const normalized = status.toLowerCase();
  if (normalized.includes('strained') || normalized.includes('overreach')) return 'high';
  if (
    normalized.includes('unproductive') ||
    normalized.includes('detraining') ||
    normalized.includes('recovery')
  ) {
    return 'moderate';
  }
  if (
    normalized.includes('productive') ||
    normalized.includes('peaking') ||
    normalized.includes('maintaining')
  ) {
    return 'low';
  }
  if (normalized.includes('no')) return 'unknown';
  return 'unknown';
}

function recoveryTimeRisk(hours: number | null): TrainingCapacity['recovery']['recoveryTimeRisk'] {
  if (hours === null) return 'unknown';
  if (hours >= 36) return 'high';
  if (hours >= 18) return 'moderate';
  return 'low';
}

function longSessionShareCap(sport: CapacitySport, level: CapacityLevel): number {
  if (sport === 'running') {
    if (level === 'novice') return 0.3;
    if (level === 'developing') return 0.35;
    if (level === 'trained') return 0.4;
    return 0.45;
  }
  if (sport === 'cycling') {
    if (level === 'novice') return 0.35;
    if (level === 'developing') return 0.45;
    if (level === 'trained') return 0.5;
    return 0.55;
  }
  return 0.4;
}

function latestActivityWith(
  activities: NormalizedActivity[],
  predicate: (activity: NormalizedActivity) => boolean,
): NormalizedActivity | null {
  return activities
    .filter((a) => a.startTimeLocal && predicate(a))
    .sort((a, b) => (b.startTimeLocal?.getTime() ?? 0) - (a.startTimeLocal?.getTime() ?? 0))[0] ?? null;
}

function isReliable(activity: NormalizedActivity, qualities: Map<string, QualityResult>): boolean {
  return (qualities.get(activity.id)?.confidence ?? 'high') !== 'low';
}

function hasPhysiologicalSignal(activity: NormalizedActivity): boolean {
  return (
    activity.averageHr !== null ||
    activity.averagePower !== null ||
    activity.normalizedPower !== null ||
    activity.trainingLoad !== null ||
    activity.aerobicTrainingEffect !== null ||
    activity.averagePaceSecPerKm !== null ||
    activity.averagePaceSecPer100m !== null
  );
}

function isCapacitySport(sport: Sport): sport is CapacitySport {
  return sport === 'running' || sport === 'cycling' || sport === 'swimming';
}

function isNormalizedCapacitySport(sport: NormalizedSport): sport is CapacitySport {
  return sport === 'running' || sport === 'cycling' || sport === 'swimming';
}

function withinDays(activity: NormalizedActivity, days: number, asOfMs: number): boolean {
  const ts = activity.startTimeLocal?.getTime();
  if (!ts) return false;
  const age = asOfMs - ts;
  return age >= 0 && age <= days * DAY_MS;
}

function computeMonotony(values: number[]): number | null {
  const active = values.filter((v) => v > 0);
  if (active.length < 4) return null;
  const meanValue = sum(values) / values.length;
  const variance = sum(values.map((v) => (v - meanValue) ** 2)) / values.length;
  const sd = Math.sqrt(variance);
  if (!Number.isFinite(sd) || sd <= 0) return null;
  return roundTo(meanValue / sd, 2);
}

function percentile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[idx];
}

function share(value: number, total: number): number | null {
  if (total <= 0) return null;
  return roundTo(value / total, 3);
}

function fromSports<T>(read: (sport: CapacitySport) => T): Record<CapacitySport, T> {
  return {
    running: read('running'),
    cycling: read('cycling'),
    swimming: read('swimming'),
  };
}

function sum(values: number[]): number {
  return values.reduce((acc, n) => acc + (Number.isFinite(n) ? n : 0), 0);
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
