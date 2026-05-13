// Rule-based training evaluation engine.
// Compares planned workouts to actual Garmin activities and produces a
// structured score + Chinese-language commentary.
// Pure functions, no I/O, no DB, no LLM.

import type { NormalizedActivity } from './activity-normalizer.js';
import type { QualityResult } from './activity-quality.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Verdict =
  | 'matched'
  | 'under_done'
  | 'over_done'
  | 'different_sport'
  | 'missed'
  | 'rest_day_active';

export interface WorkoutActivityPairing {
  workoutId: string;
  workoutTitle: string;
  sport: string;
  matchedActivityRef: { region: string; activityId: string } | null;
  verdict: 'matched' | 'partial' | 'missed' | 'different_sport';
  subScore: number;
  notes: string[];
}

export interface TrainingEvaluationResult {
  title: string;
  summary: string;
  score: number;
  verdict: Verdict;
  plannedWorkoutCount: number;
  activityCount: number;
  adherence: {
    sportMatched: boolean;
    durationRatio: number | null;
    distanceRatio: number | null;
    intensityMatched: boolean | null;
  };
  load: { planned: string | null; actual: number | null; comment: string };
  intensity: { planned: string | null; actual: string | null; comment: string };
  highlights: string[];
  risks: string[];
  suggestions: string[];
  pairings: WorkoutActivityPairing[];
}

export interface EvaluateInput {
  plannedWorkouts: PlannedWorkout[];
  activities: NormalizedActivity[];
  activityQualities: Map<string, QualityResult>;
}

export interface PlannedWorkout {
  id: string;
  title: string;
  sport: string;
  intensity: string;
  durationMinutes: number | null;
  distanceKm: string | number | null;
  targetMetric: string;
  targetHeartRate: string | null;
  targetPace: string | null;
  targetPower: string | null;
  workoutType: string | null;
}

// ---------------------------------------------------------------------------
// Target string parsers
// ---------------------------------------------------------------------------

interface TargetRange {
  low: number | null;
  high: number | null;
}

const NA = '不适用';

export function parseHrTarget(s: string | null | undefined): TargetRange | null {
  if (!s || s === NA) return null;
  // "132-146 bpm"
  const range = s.match(/^(\d+)\s*-\s*(\d+)\s*bpm$/i);
  if (range) return { low: Number(range[1]), high: Number(range[2]) };
  // "<150 bpm"
  const cap = s.match(/^<\s*(\d+)\s*bpm$/i);
  if (cap) return { low: null, high: Number(cap[1]) };
  return null;
}

export function parsePaceTarget(s: string | null | undefined): TargetRange | null {
  if (!s || s === NA) return null;
  const unit = s.includes('/100m') ? '/100m' : '/km';
  // "5:00-5:10/km" or "1:20-1:25/100m"
  const range = s.match(/^(\d+:\d+)\s*-\s*(\d+:\d+)/);
  if (range) return { low: mmssToSec(range[1]), high: mmssToSec(range[2]) };
  // "不快于 6:20/km" or "不快于 1:40/100m"
  const cap = s.match(/不快于\s*(\d+:\d+)/);
  if (cap) return { low: null, high: mmssToSec(cap[1]) };
  // Single pace "5:00/km"
  const single = s.match(/^(\d+:\d+)/);
  if (single) {
    const v = mmssToSec(single[1]);
    return v !== null ? { low: v, high: v } : null;
  }
  return null;
}

export function parsePowerTarget(s: string | null | undefined): TargetRange | null {
  if (!s || s === NA) return null;
  // "200-250 W"
  const range = s.match(/^(\d+)\s*-\s*(\d+)\s*W$/i);
  if (range) return { low: Number(range[1]), high: Number(range[2]) };
  // "<180 W"
  const cap = s.match(/^<\s*(\d+)\s*W$/i);
  if (cap) return { low: null, high: Number(cap[1]) };
  return null;
}

function mmssToSec(mmss: string): number | null {
  const parts = mmss.split(':');
  if (parts.length !== 2) return null;
  const m = Number(parts[0]);
  const ss = Number(parts[1]);
  if (!Number.isFinite(m) || !Number.isFinite(ss)) return null;
  return m * 60 + ss;
}

// ---------------------------------------------------------------------------
// Sport matching helpers
// ---------------------------------------------------------------------------

const REST_SPORTS = new Set(['rest']);
const FLEXIBLE_SPORTS = new Set(['strength', 'mobility']);

function sportsMatch(planned: string, actual: string): boolean {
  if (planned === actual) return true;
  if (FLEXIBLE_SPORTS.has(planned) && actual === 'other') return true;
  return false;
}

function normalizedPlannedSport(s: string): string {
  return s;
}

// ---------------------------------------------------------------------------
// Pairing: greedy 1:1 matching
// ---------------------------------------------------------------------------

const INTENSITY_ORDER: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

function buildPairings(
  workouts: PlannedWorkout[],
  activities: NormalizedActivity[],
): WorkoutActivityPairing[] {
  const sorted = [...workouts].sort(
    (a, b) => (INTENSITY_ORDER[b.intensity] ?? 0) - (INTENSITY_ORDER[a.intensity] ?? 0),
  );
  const used = new Set<string>();
  const pairings: WorkoutActivityPairing[] = [];

  for (const w of sorted) {
    if (REST_SPORTS.has(w.sport)) {
      pairings.push({
        workoutId: w.id,
        workoutTitle: w.title,
        sport: w.sport,
        matchedActivityRef: null,
        verdict: 'matched',
        subScore: 100,
        notes: [],
      });
      continue;
    }

    let bestActivity: NormalizedActivity | null = null;
    let bestScore = -1;

    for (const a of activities) {
      if (used.has(a.id)) continue;
      const sportOk = sportsMatch(w.sport, a.sport);
      let score = sportOk ? 100 : 0;
      if (w.durationMinutes && w.durationMinutes > 0 && a.durationMin > 0) {
        const ratio = a.durationMin / w.durationMinutes;
        score += 50 * Math.max(0, 1 - Math.abs(ratio - 1));
      }
      if (score > bestScore) {
        bestScore = score;
        bestActivity = a;
      }
    }

    if (bestActivity) {
      used.add(bestActivity.id);
      const pairing = scorePairing(w, bestActivity);
      pairings.push(pairing);
    } else {
      pairings.push({
        workoutId: w.id,
        workoutTitle: w.title,
        sport: w.sport,
        matchedActivityRef: null,
        verdict: 'missed',
        subScore: 0,
        notes: ['未找到匹配的运动记录'],
      });
    }
  }

  return pairings;
}

// ---------------------------------------------------------------------------
// Per-pairing scoring
// ---------------------------------------------------------------------------

function scorePairing(
  w: PlannedWorkout,
  a: NormalizedActivity,
): WorkoutActivityPairing {
  const notes: string[] = [];
  let sportScore = 0;
  let durationScore = 0;
  let distanceScore = 0;
  let intensityScore = 0;
  let hasDuration = false;
  let hasDistance = false;
  let hasIntensity = false;

  // Sport match (30%)
  const sportOk = sportsMatch(w.sport, a.sport);
  sportScore = sportOk ? 100 : 0;
  if (!sportOk) {
    notes.push(`运动类型不匹配：计划 ${sportZh(w.sport)}，实际 ${sportZh(a.sport)}`);
  }

  // Duration match (25%)
  if (w.durationMinutes && w.durationMinutes > 0 && a.durationMin > 0) {
    hasDuration = true;
    const ratio = a.durationMin / w.durationMinutes;
    durationScore = ratioToScore(ratio);
    if (ratio < 0.75) notes.push(`时长不足：完成了计划的 ${pct(ratio)}`);
    else if (ratio > 1.25) notes.push(`时长超出：实际为计划的 ${pct(ratio)}`);
  }

  // Distance match (20%)
  const plannedDist = toNumber(w.distanceKm);
  if (plannedDist && plannedDist > 0 && a.distanceKm > 0) {
    hasDistance = true;
    const ratio = a.distanceKm / plannedDist;
    distanceScore = ratioToScore(ratio);
    if (ratio < 0.75) notes.push(`距离不足：完成了计划的 ${pct(ratio)}`);
    else if (ratio > 1.25) notes.push(`距离超出：实际为计划的 ${pct(ratio)}`);
  }

  // Intensity match (25%)
  const intensityResult = compareIntensity(w, a);
  if (intensityResult !== null) {
    hasIntensity = true;
    intensityScore = intensityResult.score;
    if (intensityResult.note) notes.push(intensityResult.note);
  }

  // Weights: sport 30%, duration 25%, distance 20%, intensity 25%
  // If a dimension is missing, redistribute its weight proportionally
  let totalWeight = 0;
  let weightedSum = 0;

  const dims: Array<{ score: number; weight: number; has: boolean }> = [
    { score: sportScore, weight: 30, has: true },
    { score: durationScore, weight: 25, has: hasDuration },
    { score: distanceScore, weight: 20, has: hasDistance },
    { score: intensityScore, weight: 25, has: hasIntensity },
  ];

  for (const d of dims) {
    if (d.has) {
      totalWeight += d.weight;
      weightedSum += d.score * d.weight;
    }
  }

  const subScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : (sportOk ? 50 : 0);

  let verdict: WorkoutActivityPairing['verdict'];
  if (!sportOk) verdict = 'different_sport';
  else if (subScore >= 70) verdict = 'matched';
  else if (subScore >= 40) verdict = 'partial';
  else verdict = 'missed';

  return {
    workoutId: w.id,
    workoutTitle: w.title,
    sport: w.sport,
    matchedActivityRef: { region: a.region, activityId: String(a.activityId) },
    verdict,
    subScore,
    notes,
  };
}

function ratioToScore(ratio: number): number {
  // 1.0 = perfect (100), 0.75/1.25 boundary = 60, 0.5/1.5 = 30, outside = 0
  const dev = Math.abs(ratio - 1.0);
  if (dev <= 0.25) return Math.round(100 - dev * 160); // 100→60 over 0→0.25
  if (dev <= 0.5) return Math.round(60 - (dev - 0.25) * 120); // 60→30 over 0.25→0.5
  return Math.max(0, Math.round(30 - (dev - 0.5) * 60));
}

// ---------------------------------------------------------------------------
// Intensity comparison
// ---------------------------------------------------------------------------

interface IntensityCompareResult {
  score: number;
  note: string | null;
}

function compareIntensity(
  w: PlannedWorkout,
  a: NormalizedActivity,
): IntensityCompareResult | null {
  // Try HR first, then pace, then power based on targetMetric
  const metric = w.targetMetric;

  if (metric === 'heart_rate' || metric === 'mixed') {
    const hr = compareHr(w, a);
    if (hr) return hr;
  }
  if (metric === 'pace' || metric === 'mixed') {
    const pace = comparePace(w, a);
    if (pace) return pace;
  }
  if (metric === 'power' || metric === 'mixed') {
    const power = comparePower(w, a);
    if (power) return power;
  }

  // Fallback: try all
  const hr = compareHr(w, a);
  if (hr) return hr;
  const pace = comparePace(w, a);
  if (pace) return pace;
  const power = comparePower(w, a);
  if (power) return power;

  return null;
}

function compareHr(
  w: PlannedWorkout,
  a: NormalizedActivity,
): IntensityCompareResult | null {
  const target = parseHrTarget(w.targetHeartRate);
  if (!target) return null;
  if (a.averageHr === null) return null;

  const actual = a.averageHr;
  const tolerance = 0.1;
  const effectiveLow = target.low !== null ? target.low * (1 - tolerance) : null;
  const effectiveHigh = target.high !== null ? target.high * (1 + tolerance) : null;

  const inRange =
    (effectiveLow === null || actual >= effectiveLow) &&
    (effectiveHigh === null || actual <= effectiveHigh);

  if (inRange) {
    return { score: 100, note: null };
  }

  if (effectiveHigh !== null && actual > effectiveHigh) {
    const over = Math.round(actual - (target.high ?? actual));
    return {
      score: Math.max(0, 100 - over * 4),
      note: `心率偏高：平均 ${Math.round(actual)} bpm，超出目标上限 ${over} bpm`,
    };
  }

  if (effectiveLow !== null && actual < effectiveLow) {
    const under = Math.round((target.low ?? actual) - actual);
    return {
      score: Math.max(30, 100 - under * 3),
      note: `心率偏低：平均 ${Math.round(actual)} bpm，低于目标下限 ${under} bpm`,
    };
  }

  return { score: 70, note: null };
}

function comparePace(
  w: PlannedWorkout,
  a: NormalizedActivity,
): IntensityCompareResult | null {
  const target = parsePaceTarget(w.targetPace);
  if (!target) return null;

  const isSwim = w.sport === 'swimming';
  const actual = isSwim ? a.averagePaceSecPer100m : a.averagePaceSecPerKm;
  if (actual === null) return null;

  const tolerance = 0.1;
  // Pace: lower is faster. Target range [low, high] = [fast, slow]
  const effectiveLow = target.low !== null ? target.low * (1 - tolerance) : null;
  const effectiveHigh = target.high !== null ? target.high * (1 + tolerance) : null;

  const inRange =
    (effectiveLow === null || actual >= effectiveLow) &&
    (effectiveHigh === null || actual <= effectiveHigh);

  if (inRange) {
    return { score: 100, note: null };
  }

  const unit = isSwim ? '/100m' : '/km';
  if (effectiveLow !== null && actual < effectiveLow) {
    return {
      score: 70,
      note: `配速偏快：实际 ${secToMmss(actual)}${unit}，快于目标范围`,
    };
  }
  if (effectiveHigh !== null && actual > effectiveHigh) {
    return {
      score: Math.max(30, 70),
      note: `配速偏慢：实际 ${secToMmss(actual)}${unit}，慢于目标范围`,
    };
  }

  return { score: 70, note: null };
}

function comparePower(
  w: PlannedWorkout,
  a: NormalizedActivity,
): IntensityCompareResult | null {
  const target = parsePowerTarget(w.targetPower);
  if (!target) return null;
  if (a.averagePower === null) return null;

  const actual = a.averagePower;
  const tolerance = 0.1;
  const effectiveLow = target.low !== null ? target.low * (1 - tolerance) : null;
  const effectiveHigh = target.high !== null ? target.high * (1 + tolerance) : null;

  const inRange =
    (effectiveLow === null || actual >= effectiveLow) &&
    (effectiveHigh === null || actual <= effectiveHigh);

  if (inRange) {
    return { score: 100, note: null };
  }

  if (effectiveHigh !== null && actual > effectiveHigh) {
    const over = Math.round(actual - (target.high ?? actual));
    return {
      score: Math.max(30, 100 - over),
      note: `功率偏高：平均 ${Math.round(actual)} W，超出目标 ${over} W`,
    };
  }
  if (effectiveLow !== null && actual < effectiveLow) {
    const under = Math.round((target.low ?? actual) - actual);
    return {
      score: Math.max(30, 100 - under),
      note: `功率偏低：平均 ${Math.round(actual)} W，低于目标 ${under} W`,
    };
  }

  return { score: 70, note: null };
}

// ---------------------------------------------------------------------------
// Load estimation
// ---------------------------------------------------------------------------

function estimatedLoadRange(intensity: string): [number, number] {
  switch (intensity) {
    case 'high': return [80, 150];
    case 'medium': return [40, 80];
    case 'low': return [15, 40];
    default: return [20, 60];
  }
}

function buildLoadComment(
  workouts: PlannedWorkout[],
  activities: NormalizedActivity[],
): { planned: string | null; actual: number | null; comment: string } {
  const totalActualLoad = activities.reduce(
    (sum, a) => sum + (a.trainingLoad ?? 0),
    0,
  );
  const hasActualLoad = activities.some((a) => a.trainingLoad !== null);

  if (workouts.length === 0) {
    return {
      planned: null,
      actual: hasActualLoad ? totalActualLoad : null,
      comment: hasActualLoad ? `实际训练负荷 ${totalActualLoad}` : '无负荷数据',
    };
  }

  let totalLow = 0;
  let totalHigh = 0;
  for (const w of workouts) {
    if (REST_SPORTS.has(w.sport)) continue;
    const [lo, hi] = estimatedLoadRange(w.intensity);
    totalLow += lo;
    totalHigh += hi;
  }

  const planned = totalLow === totalHigh
    ? `~${totalLow}`
    : `${totalLow}-${totalHigh}`;

  if (!hasActualLoad) {
    return { planned, actual: null, comment: '设备未记录训练负荷数据' };
  }

  let comment: string;
  if (totalActualLoad < totalLow * 0.7) {
    comment = `训练负荷偏低：实际 ${totalActualLoad}，期望 ${planned}`;
  } else if (totalActualLoad > totalHigh * 1.3) {
    comment = `训练负荷偏高：实际 ${totalActualLoad}，期望 ${planned}`;
  } else {
    comment = `训练负荷在合理范围：实际 ${totalActualLoad}，期望 ${planned}`;
  }

  return { planned, actual: totalActualLoad, comment };
}

// ---------------------------------------------------------------------------
// Intensity summary
// ---------------------------------------------------------------------------

function buildIntensitySummary(
  workouts: PlannedWorkout[],
  activities: NormalizedActivity[],
): { planned: string | null; actual: string | null; comment: string } {
  const nonRest = workouts.filter((w) => !REST_SPORTS.has(w.sport));
  if (nonRest.length === 0) {
    return { planned: null, actual: null, comment: '计划为休息日' };
  }

  const planned = nonRest.map((w) => intensityZh(w.intensity)).join('、');

  const actualParts: string[] = [];
  for (const a of activities) {
    if (a.averageHr) actualParts.push(`HR ${Math.round(a.averageHr)}`);
    else if (a.averagePaceSecPerKm) actualParts.push(`配速 ${secToMmss(a.averagePaceSecPerKm)}/km`);
    else if (a.averagePower) actualParts.push(`${Math.round(a.averagePower)}W`);
  }

  return {
    planned,
    actual: actualParts.length > 0 ? actualParts.join('、') : null,
    comment: actualParts.length > 0 ? `计划强度 ${planned}` : '缺少强度数据',
  };
}

// ---------------------------------------------------------------------------
// Main evaluation function
// ---------------------------------------------------------------------------

export function evaluateTrainingDay(input: EvaluateInput): TrainingEvaluationResult {
  const { plannedWorkouts, activities, activityQualities } = input;

  const isRestDay = plannedWorkouts.length > 0 &&
    plannedWorkouts.every((w) => REST_SPORTS.has(w.sport));

  // Rest day with activities
  if (isRestDay && activities.length > 0) {
    return buildRestDayActiveResult(plannedWorkouts, activities);
  }

  // Rest day, no activities — perfect
  if (isRestDay && activities.length === 0) {
    return buildRestDayCleanResult(plannedWorkouts);
  }

  // No planned workouts but activities exist (shouldn't happen per API validation, but handle)
  if (plannedWorkouts.length === 0) {
    return buildNoPlannedResult(activities);
  }

  // Normal evaluation: pair and score
  const pairings = buildPairings(plannedWorkouts, activities);

  // Apply quality penalties
  for (const p of pairings) {
    if (p.matchedActivityRef) {
      const key = `${p.matchedActivityRef.region}-${p.matchedActivityRef.activityId}`;
      const q = activityQualities.get(key);
      if (q && q.confidence === 'low') {
        p.subScore = Math.round(p.subScore * 0.7);
        p.notes.push('活动数据可信度较低，评分已折扣');
      }
    }
  }

  // Aggregate score
  const nonRestPairings = pairings.filter((p) => !REST_SPORTS.has(p.sport));
  let score: number;
  if (nonRestPairings.length > 0) {
    const totalSub = nonRestPairings.reduce((s, p) => s + p.subScore, 0);
    score = Math.round(totalSub / nonRestPairings.length);
  } else {
    score = 50;
  }
  score = clamp(score, 0, 100);

  // Adherence
  const allSportsMatched = nonRestPairings.every(
    (p) => p.verdict === 'matched' || p.verdict === 'partial',
  );
  const avgDurationRatio = computeAvgRatio(plannedWorkouts, activities, 'duration');
  const avgDistanceRatio = computeAvgRatio(plannedWorkouts, activities, 'distance');
  const intensityResults = nonRestPairings.map((p) => p.verdict);
  const intensityMatched = intensityResults.length > 0
    ? intensityResults.every((v) => v === 'matched')
    : null;

  // Verdict
  const verdict = determineVerdict(score, allSportsMatched, avgDurationRatio, avgDistanceRatio, pairings);

  // Text generation
  const highlights = buildHighlights(pairings, activities);
  const risks = buildRisks(pairings, activities, activityQualities);
  const suggestions = buildSuggestions(verdict, pairings);
  const load = buildLoadComment(plannedWorkouts, activities);
  const intensity = buildIntensitySummary(plannedWorkouts, activities);
  const title = buildTitle(verdict, score);
  const summary = buildSummary(verdict, score, pairings, plannedWorkouts, activities);

  return {
    title,
    summary,
    score,
    verdict,
    plannedWorkoutCount: plannedWorkouts.length,
    activityCount: activities.length,
    adherence: {
      sportMatched: allSportsMatched,
      durationRatio: avgDurationRatio,
      distanceRatio: avgDistanceRatio,
      intensityMatched,
    },
    load,
    intensity,
    highlights,
    risks,
    suggestions,
    pairings,
  };
}

// ---------------------------------------------------------------------------
// Verdict determination
// ---------------------------------------------------------------------------

function determineVerdict(
  score: number,
  allSportsMatched: boolean,
  avgDurationRatio: number | null,
  avgDistanceRatio: number | null,
  pairings: WorkoutActivityPairing[],
): Verdict {
  if (!allSportsMatched && pairings.some((p) => p.verdict === 'different_sport')) {
    return 'different_sport';
  }

  const hasMissed = pairings.some((p) => p.verdict === 'missed' && !REST_SPORTS.has(p.sport));
  if (score < 40 || (hasMissed && pairings.filter((p) => !REST_SPORTS.has(p.sport)).length === pairings.filter((p) => p.verdict === 'missed' && !REST_SPORTS.has(p.sport)).length)) {
    return 'missed';
  }

  const avgRatio = avgDurationRatio ?? avgDistanceRatio;
  if (avgRatio !== null && avgRatio < 0.7) return 'under_done';
  if (avgRatio !== null && avgRatio > 1.4) return 'over_done';

  if (score >= 70) return 'matched';
  if (avgRatio !== null && avgRatio < 0.85) return 'under_done';
  if (avgRatio !== null && avgRatio > 1.2) return 'over_done';

  return score >= 50 ? 'matched' : 'under_done';
}

// ---------------------------------------------------------------------------
// Special-case results
// ---------------------------------------------------------------------------

function buildRestDayActiveResult(
  workouts: PlannedWorkout[],
  activities: NormalizedActivity[],
): TrainingEvaluationResult {
  const totalLoad = activities.reduce((s, a) => s + (a.trainingLoad ?? 0), 0);
  const isLight = totalLoad < 40 && activities.every((a) => (a.durationMin ?? 0) < 45);

  const highlights = isLight
    ? ['休息日进行了轻度活动，有助于恢复']
    : [];
  const risks = !isLight
    ? ['休息日运动强度偏高，可能影响恢复']
    : [];
  const suggestions = !isLight
    ? ['建议休息日以轻度活动为主，控制时间和强度']
    : ['继续保持适度的恢复性活动'];

  return {
    title: isLight ? '休息日活动 (合理)' : '休息日活动 (偏多)',
    summary: isLight
      ? `计划为休息日，你进行了${activities.length}项轻度活动，有助于积极恢复。`
      : `计划为休息日，但实际进行了${activities.length}项运动，总负荷 ${totalLoad}，建议注意恢复。`,
    score: isLight ? 80 : 50,
    verdict: 'rest_day_active',
    plannedWorkoutCount: workouts.length,
    activityCount: activities.length,
    adherence: {
      sportMatched: true,
      durationRatio: null,
      distanceRatio: null,
      intensityMatched: null,
    },
    load: {
      planned: '0 (休息日)',
      actual: totalLoad > 0 ? totalLoad : null,
      comment: isLight ? '轻度活动，不影响恢复' : '负荷偏高，建议注意恢复',
    },
    intensity: {
      planned: '休息',
      actual: null,
      comment: isLight ? '轻度活动' : '强度偏高',
    },
    highlights,
    risks,
    suggestions,
    pairings: workouts.map((w) => ({
      workoutId: w.id,
      workoutTitle: w.title,
      sport: w.sport,
      matchedActivityRef: null,
      verdict: 'matched' as const,
      subScore: isLight ? 80 : 50,
      notes: isLight ? ['轻度恢复活动'] : ['休息日运动强度偏高'],
    })),
  };
}

function buildRestDayCleanResult(workouts: PlannedWorkout[]): TrainingEvaluationResult {
  return {
    title: '休息日 — 完成',
    summary: '计划为休息日，你按计划休息了，做得好！',
    score: 100,
    verdict: 'matched',
    plannedWorkoutCount: workouts.length,
    activityCount: 0,
    adherence: {
      sportMatched: true,
      durationRatio: null,
      distanceRatio: null,
      intensityMatched: null,
    },
    load: { planned: '0 (休息日)', actual: null, comment: '按计划休息' },
    intensity: { planned: '休息', actual: null, comment: '按计划休息' },
    highlights: ['按计划执行了休息日'],
    risks: [],
    suggestions: [],
    pairings: workouts.map((w) => ({
      workoutId: w.id,
      workoutTitle: w.title,
      sport: w.sport,
      matchedActivityRef: null,
      verdict: 'matched' as const,
      subScore: 100,
      notes: [],
    })),
  };
}

function buildNoPlannedResult(activities: NormalizedActivity[]): TrainingEvaluationResult {
  return {
    title: '自由训练',
    summary: `当天没有训练计划，但完成了${activities.length}项运动。`,
    score: 60,
    verdict: 'matched',
    plannedWorkoutCount: 0,
    activityCount: activities.length,
    adherence: {
      sportMatched: true,
      durationRatio: null,
      distanceRatio: null,
      intensityMatched: null,
    },
    load: buildLoadComment([], activities),
    intensity: buildIntensitySummary([], activities),
    highlights: [`完成了${activities.length}项运动`],
    risks: [],
    suggestions: [],
    pairings: [],
  };
}

// ---------------------------------------------------------------------------
// Chinese text generation
// ---------------------------------------------------------------------------

const VERDICT_TITLE: Record<Verdict, string> = {
  matched: '训练达标',
  under_done: '训练不足',
  over_done: '训练过量',
  different_sport: '项目不匹配',
  missed: '训练缺失',
  rest_day_active: '休息日活动',
};

function buildTitle(verdict: Verdict, score: number): string {
  return `${VERDICT_TITLE[verdict]} (${score}分)`;
}

function buildSummary(
  verdict: Verdict,
  score: number,
  pairings: WorkoutActivityPairing[],
  workouts: PlannedWorkout[],
  activities: NormalizedActivity[],
): string {
  const matched = pairings.filter((p) => p.verdict === 'matched').length;
  const total = pairings.filter((p) => !REST_SPORTS.has(p.sport)).length;

  switch (verdict) {
    case 'matched':
      return `今日训练计划执行良好，${matched}/${total} 项训练达标。继续保持！`;
    case 'under_done':
      return `今日训练量不足，完成度低于计划要求。建议下次尽量按计划完成全部训练内容。`;
    case 'over_done':
      return `今日训练量超出计划，注意控制训练量，避免过度疲劳影响后续训练。`;
    case 'different_sport':
      return `实际运动项目与计划不一致。如果是有意调整请忽略，否则建议按计划项目执行。`;
    case 'missed':
      return `今日计划训练未完成。如果是身体原因，建议休息恢复；否则尽快补上。`;
    case 'rest_day_active':
      return `计划为休息日，但有运动记录。适度活动有益恢复，但注意不要过量。`;
  }
}

function buildHighlights(
  pairings: WorkoutActivityPairing[],
  activities: NormalizedActivity[],
): string[] {
  const highlights: string[] = [];

  const matched = pairings.filter((p) => p.verdict === 'matched');
  if (matched.length > 0) {
    for (const p of matched) {
      if (p.subScore >= 85) {
        highlights.push(`${p.workoutTitle} 完成质量优秀`);
      } else {
        highlights.push(`完成了计划的 ${p.workoutTitle}`);
      }
    }
  }

  for (const p of pairings) {
    for (const note of p.notes) {
      if (note.includes('心率控制') || note.includes('配速在目标')) {
        highlights.push(note);
      }
    }
  }

  // Extra activities
  const matchedRefs = new Set(
    pairings
      .filter((p) => p.matchedActivityRef)
      .map((p) => `${p.matchedActivityRef!.region}:${p.matchedActivityRef!.activityId}`),
  );
  const extra = activities.filter(
    (a) => !matchedRefs.has(`${a.region}:${String(a.activityId)}`),
  );
  if (extra.length > 0) {
    highlights.push(`额外完成了 ${extra.length} 项运动`);
  }

  return highlights;
}

function buildRisks(
  pairings: WorkoutActivityPairing[],
  activities: NormalizedActivity[],
  qualities: Map<string, QualityResult>,
): string[] {
  const risks: string[] = [];

  for (const p of pairings) {
    for (const note of p.notes) {
      if (
        note.includes('偏高') ||
        note.includes('偏低') ||
        note.includes('不足') ||
        note.includes('超出') ||
        note.includes('不匹配')
      ) {
        risks.push(note);
      }
    }
  }

  for (const a of activities) {
    const key = `${a.region}-${String(a.activityId)}`;
    const q = qualities.get(key);
    if (q && q.confidence === 'low') {
      risks.push('部分活动数据可信度较低，评价结果仅供参考');
      break;
    }
  }

  return [...new Set(risks)];
}

function buildSuggestions(
  verdict: Verdict,
  pairings: WorkoutActivityPairing[],
): string[] {
  const suggestions: string[] = [];

  switch (verdict) {
    case 'under_done':
      suggestions.push('下次尽量按计划完成全部训练内容');
      if (pairings.some((p) => p.notes.some((n) => n.includes('时长不足')))) {
        suggestions.push('可以适当延长训练时间以达到计划要求');
      }
      break;
    case 'over_done':
      suggestions.push('注意控制训练量，过度训练可能增加受伤风险');
      suggestions.push('如果感到疲劳，下次训练可适当降低强度');
      break;
    case 'different_sport':
      suggestions.push('建议按照计划的运动项目执行，以保持训练的系统性');
      break;
    case 'missed':
      suggestions.push('如果因身体原因缺席，建议充分休息后再恢复训练');
      suggestions.push('如果是时间原因，可考虑调整训练时间安排');
      break;
    case 'matched':
      if (pairings.some((p) => p.notes.some((n) => n.includes('心率偏高')))) {
        suggestions.push('尝试全程保持在目标心率区间内');
      }
      if (pairings.some((p) => p.notes.some((n) => n.includes('配速偏快')))) {
        suggestions.push('控制配速在目标范围内，避免前半程过快');
      }
      break;
  }

  return suggestions;
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function computeAvgRatio(
  workouts: PlannedWorkout[],
  activities: NormalizedActivity[],
  kind: 'duration' | 'distance',
): number | null {
  let totalPlanned = 0;
  let totalActual = 0;
  let count = 0;

  for (const w of workouts) {
    if (REST_SPORTS.has(w.sport)) continue;
    const planned = kind === 'duration' ? (w.durationMinutes ?? 0) : toNumber(w.distanceKm) ?? 0;
    if (planned <= 0) continue;
    totalPlanned += planned;
    count++;
  }

  if (count === 0 || totalPlanned === 0) return null;

  for (const a of activities) {
    totalActual += kind === 'duration' ? a.durationMin : a.distanceKm;
  }

  return Math.round((totalActual / totalPlanned) * 100) / 100;
}

function toNumber(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function secToMmss(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const SPORT_ZH: Record<string, string> = {
  running: '跑步',
  cycling: '骑行',
  swimming: '游泳',
  rest: '休息',
  strength: '力量',
  mobility: '恢复活动',
  other: '其他',
};

function sportZh(s: string): string {
  return SPORT_ZH[s] ?? s;
}

const INTENSITY_ZH: Record<string, string> = {
  low: '低强度',
  medium: '中强度',
  high: '高强度',
};

function intensityZh(s: string): string {
  return INTENSITY_ZH[s] ?? s;
}
