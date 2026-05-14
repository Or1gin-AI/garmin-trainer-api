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

export interface PhysiologyMetrics {
  edwardsTRIMP: number | null;
  garminLoad: number | null;
  aerobicTE: number | null;
  anaerobicTE: number | null;
  hrZone: number | null;
  plannedZone: string | null;
  zoneMatch: boolean | null;
  intensityFactor: number | null;
  tss: number | null;
  recoveryHoursRemaining: number | null;
  hrvStatus: string | null;
  sleepScore: number | null;
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
  physiology: PhysiologyMetrics | null;
}

export interface EvaluateInput {
  plannedWorkouts: PlannedWorkout[];
  activities: NormalizedActivity[];
  activityQualities: Map<string, QualityResult>;
  athleteMaxHr?: number | null;
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
      actual: hasActualLoad ? Math.round(totalActualLoad) : null,
      comment: hasActualLoad ? `实际训练负荷 ${Math.round(totalActualLoad)}` : '无负荷数据',
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
    comment = `训练负荷偏低：实际 ${Math.round(totalActualLoad)}，期望 ${planned}`;
  } else if (totalActualLoad > totalHigh * 1.3) {
    comment = `训练负荷偏高：实际 ${Math.round(totalActualLoad)}，期望 ${planned}`;
  } else {
    comment = `训练负荷在合理范围：实际 ${Math.round(totalActualLoad)}，期望 ${planned}`;
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

  // Determine HRmax for physiology calculations.
  // IMPORTANT: a single activity's maxHr is NOT the athlete's true HRmax —
  // it's just the peak HR reached in that session (typically 80-95% of true max).
  // Use input.athleteMaxHr if provided; otherwise apply a correction factor.
  let maxHr = 190;
  if (input.athleteMaxHr && input.athleteMaxHr > 0) {
    maxHr = input.athleteMaxHr;
  } else {
    const observedMax = Math.max(...activities.map((a) => a.maxHr ?? 0).filter((v) => v > 0), 0);
    if (observedMax > 0) {
      // Observed peak in a single session is ~90-95% of true HRmax on average.
      // Use 95th percentile estimate: true HRmax ≈ observed / 0.93
      maxHr = Math.round(observedMax / 0.93);
    }
  }

  const isRestDay = plannedWorkouts.length > 0 &&
    plannedWorkouts.every((w) => REST_SPORTS.has(w.sport));

  // Rest day with activities
  if (isRestDay && activities.length > 0) {
    const result = buildRestDayActiveResult(plannedWorkouts, activities);
    result.physiology = buildPhysiologyMetrics(plannedWorkouts, activities, maxHr);
    return result;
  }

  // Rest day, no activities — perfect
  if (isRestDay && activities.length === 0) {
    return buildRestDayCleanResult(plannedWorkouts);
  }

  // No planned workouts but activities exist (shouldn't happen per API validation, but handle)
  if (plannedWorkouts.length === 0) {
    const result = buildNoPlannedResult(activities);
    result.physiology = buildPhysiologyMetrics([], activities, maxHr);
    return result;
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

  // Physiology metrics
  const physiology = buildPhysiologyMetrics(plannedWorkouts, activities, maxHr);

  // Text generation
  const highlights = [
    ...buildHighlights(pairings, activities),
    ...buildPhysiologyHighlights(plannedWorkouts, activities, physiology),
  ];
  const risks = [
    ...buildRisks(pairings, activities, activityQualities),
    ...buildPhysiologyRisks(plannedWorkouts, activities, physiology),
  ];
  const suggestions = [
    ...buildSuggestions(verdict, pairings),
    ...buildPhysiologySuggestions(plannedWorkouts, activities, physiology),
  ];
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
    highlights: [...new Set(highlights)],
    risks: [...new Set(risks)],
    suggestions: [...new Set(suggestions)],
    pairings,
    physiology,
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
    physiology: null,
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
    physiology: null,
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
    physiology: null,
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

// ---------------------------------------------------------------------------
// Sports science: Edwards TRIMP
// ---------------------------------------------------------------------------

function computeEdwardsTRIMP(a: NormalizedActivity, maxHr: number): number | null {
  if (!a.averageHr || a.durationMin <= 0) return null;
  const zone = classifyHrZoneFromActivity(a, maxHr);
  if (zone === null) return null;
  return Math.round(a.durationMin * zone);
}

// ---------------------------------------------------------------------------
// Sports science: HR Zone classification
// Prefer Garmin's own zone boundaries (from user profile) over %HRmax.
// ---------------------------------------------------------------------------

function classifyHrZoneFromActivity(a: NormalizedActivity, _maxHr: number): number | null {
  // Use Garmin's time-in-zone data (seconds per zone) to determine the
  // primary zone. Returns a float like 2.0 or 1.5 for "between zones".
  if (!a.hrTimeInZones) {
    // Fallback: try zone boundary approach
    if (!a.averageHr || !a.heartRateZones || a.heartRateZones.length < 2) return null;
    const avg = a.averageHr;
    for (let i = a.heartRateZones.length - 1; i >= 0; i--) {
      const [low] = a.heartRateZones[i];
      if (avg >= low) return Math.min(i + 1, 5);
    }
    return 1;
  }

  const times = a.hrTimeInZones;
  const total = times[0] + times[1] + times[2] + times[3] + times[4];
  if (total <= 0) return null;

  // Weighted average zone: sum(zone_i * time_i) / total_time
  const weighted = (1 * times[0] + 2 * times[1] + 3 * times[2] + 4 * times[3] + 5 * times[4]) / total;
  // Round to nearest 0.5
  return Math.round(weighted * 2) / 2;
}

const ZONE_LABELS: Record<string, string> = {
  '1': 'Z1 恢复', '1.5': 'Z1-2', '2': 'Z2 有氧', '2.5': 'Z2-3',
  '3': 'Z3 节奏', '3.5': 'Z3-4', '4': 'Z4 阈值', '4.5': 'Z4-5', '5': 'Z5 VO₂max',
};

function zoneLabel(z: number): string {
  return ZONE_LABELS[String(z)] ?? `Z${z}`;
}

function expectedZoneRange(workoutType: string | null, intensity: string): [number, number] {
  const wt = (workoutType ?? '').toLowerCase();
  if (wt.includes('recovery') || intensity === 'low') return [1, 2];
  if (wt.includes('aerobic') || wt.includes('endurance') || wt.includes('long')) return [2, 3];
  if (wt.includes('tempo') || wt.includes('sweet_spot')) return [3, 4];
  if (wt.includes('threshold') || wt.includes('lactate')) return [4, 4];
  if (wt.includes('vo2') || wt.includes('interval') || wt.includes('anaerobic')) return [4, 5];
  if (intensity === 'medium') return [2, 4];
  if (intensity === 'high') return [4, 5];
  return [2, 4];
}

// ---------------------------------------------------------------------------
// Sports science: Training Effect evaluation
// ---------------------------------------------------------------------------

interface TEResult {
  match: boolean;
  note: string | null;
}

function evaluateTrainingEffect(a: NormalizedActivity, intensity: string): TEResult {
  const aer = a.aerobicTrainingEffect;
  const ana = a.anaerobicTrainingEffect;
  if (aer === null) return { match: true, note: null };

  if (intensity === 'low') {
    if (aer > 3.5) {
      return { match: false, note: `有氧训练效果 ${aer.toFixed(1)}，对于恢复日偏高` };
    }
    return { match: true, note: aer <= 2.0 ? `有氧效果 ${aer.toFixed(1)}，适合恢复日` : null };
  }

  if (intensity === 'medium') {
    if (aer < 2.0) {
      return { match: false, note: `有氧效果仅 ${aer.toFixed(1)}，未达到中强度刺激水平` };
    }
    if (aer > 4.5) {
      return { match: false, note: `有氧效果 ${aer.toFixed(1)}，超出中强度计划预期` };
    }
    return { match: true, note: `有氧效果 ${aer.toFixed(1)}，符合中强度训练` };
  }

  if (intensity === 'high') {
    if (aer < 3.0 && (ana === null || ana < 1.0)) {
      return { match: false, note: `有氧效果 ${aer.toFixed(1)}${ana !== null ? `，无氧效果 ${ana.toFixed(1)}` : ''}，未达高强度目标` };
    }
    return { match: true, note: `训练效果 ${aer.toFixed(1)}/${(ana ?? 0).toFixed(1)}，达到高强度刺激` };
  }

  return { match: true, note: null };
}

// ---------------------------------------------------------------------------
// Sports science: Recovery risk check
// ---------------------------------------------------------------------------

function checkRecoveryRisks(a: NormalizedActivity, intensity: string): string[] {
  const risks: string[] = [];

  if (intensity === 'high' && a.recoveryTimeHours !== null && a.recoveryTimeHours > 24) {
    risks.push(`高强度训练时恢复时间仍剩余 ${Math.round(a.recoveryTimeHours)}h，存在过度训练风险`);
  }

  if (a.hrvStatus) {
    const lower = a.hrvStatus.toLowerCase();
    if (lower === 'low' || lower === 'poor' || lower === 'unbalanced') {
      risks.push(`HRV 状态偏低 (${a.hrvStatus})，建议关注恢复`);
    }
  }

  if (a.sleepScore !== null && a.sleepScore < 50) {
    risks.push(`前夜睡眠评分偏低 (${a.sleepScore}分)，可能影响训练质量`);
  }

  return risks;
}

// ---------------------------------------------------------------------------
// Sports science: Cycling TSS estimation
// ---------------------------------------------------------------------------

function estimateCyclingTSS(
  a: NormalizedActivity,
  targetPowerMid: number | null,
): { intensityFactor: number; tss: number } | null {
  if (a.sport !== 'cycling') return null;
  const np = a.normalizedPower ?? a.averagePower;
  if (!np || !targetPowerMid || targetPowerMid <= 0 || a.durationMin <= 0) return null;

  const intensityFactor = np / targetPowerMid;
  const tss = Math.round((a.durationMin / 60) * intensityFactor * intensityFactor * 100);
  return { intensityFactor: Math.round(intensityFactor * 100) / 100, tss };
}

// ---------------------------------------------------------------------------
// Sports science: Aggregate physiology metrics
// ---------------------------------------------------------------------------

function buildPhysiologyMetrics(
  workouts: PlannedWorkout[],
  activities: NormalizedActivity[],
  maxHr: number,
): PhysiologyMetrics | null {
  if (activities.length === 0) return null;

  let totalTRIMP = 0;
  let hasTRIMP = false;
  let totalGarminLoad = 0;
  let hasGarminLoad = false;
  let bestAerTE: number | null = null;
  let bestAnaTE: number | null = null;
  let primaryZone: number | null = null;
  let recoveryHours: number | null = null;
  let hrvStatus: string | null = null;
  let sleepScore: number | null = null;
  let ifResult: number | null = null;
  let tssResult: number | null = null;

  for (const a of activities) {
    const trimp = computeEdwardsTRIMP(a, maxHr);
    if (trimp !== null) { totalTRIMP += trimp; hasTRIMP = true; }
    if (a.trainingLoad !== null) { totalGarminLoad += a.trainingLoad; hasGarminLoad = true; }
    if (a.aerobicTrainingEffect !== null && (bestAerTE === null || a.aerobicTrainingEffect > bestAerTE)) {
      bestAerTE = a.aerobicTrainingEffect;
    }
    if (a.anaerobicTrainingEffect !== null && (bestAnaTE === null || a.anaerobicTrainingEffect > bestAnaTE)) {
      bestAnaTE = a.anaerobicTrainingEffect;
    }
    if (a.averageHr) {
      const zone = classifyHrZoneFromActivity(a, maxHr);
      if (zone !== null && (primaryZone === null || zone > primaryZone)) primaryZone = zone;
    }
    if (a.recoveryTimeHours !== null && (recoveryHours === null || a.recoveryTimeHours > recoveryHours)) {
      recoveryHours = a.recoveryTimeHours;
    }
    if (a.hrvStatus) hrvStatus = a.hrvStatus;
    if (a.sleepScore !== null) sleepScore = a.sleepScore;
  }

  // Cycling TSS from first cycling activity
  const primaryIntensity = workouts.length > 0 ? workouts[0].intensity : 'medium';
  for (const a of activities) {
    if (a.sport === 'cycling') {
      const targetMid = parsePowerMidpoint(workouts.find((w) => w.sport === 'cycling')?.targetPower);
      const tssCalc = estimateCyclingTSS(a, targetMid);
      if (tssCalc) {
        ifResult = tssCalc.intensityFactor;
        tssResult = tssCalc.tss;
      }
      break;
    }
  }

  // Planned zone
  const nonRestWorkout = workouts.find((w) => !REST_SPORTS.has(w.sport));
  let plannedZone: string | null = null;
  let zoneMatch: boolean | null = null;
  if (nonRestWorkout && primaryZone !== null) {
    const [lo, hi] = expectedZoneRange(nonRestWorkout.workoutType, nonRestWorkout.intensity);
    plannedZone = `${zoneLabel(lo)} ~ ${zoneLabel(hi)}`;
    zoneMatch = primaryZone >= lo && primaryZone <= hi;
  }

  return {
    edwardsTRIMP: hasTRIMP ? Math.round(totalTRIMP) : null,
    garminLoad: hasGarminLoad ? Math.round(totalGarminLoad) : null,
    aerobicTE: bestAerTE,
    anaerobicTE: bestAnaTE,
    hrZone: primaryZone,
    plannedZone,
    zoneMatch,
    intensityFactor: ifResult,
    tss: tssResult,
    recoveryHoursRemaining: recoveryHours,
    hrvStatus,
    sleepScore,
  };
}

function parsePowerMidpoint(s: string | null | undefined): number | null {
  if (!s) return null;
  const range = s.match(/^(\d+)\s*-\s*(\d+)\s*W$/i);
  if (range) return (Number(range[1]) + Number(range[2])) / 2;
  const single = s.match(/(\d+)\s*W/i);
  if (single) return Number(single[1]);
  return null;
}

// ---------------------------------------------------------------------------
// Sports science: Enhanced risks from physiology
// ---------------------------------------------------------------------------

function buildPhysiologyRisks(
  workouts: PlannedWorkout[],
  activities: NormalizedActivity[],
  physiology: PhysiologyMetrics | null,
): string[] {
  if (!physiology) return [];
  const risks: string[] = [];
  const primaryIntensity = workouts.find((w) => !REST_SPORTS.has(w.sport))?.intensity ?? 'medium';

  for (const a of activities) {
    risks.push(...checkRecoveryRisks(a, primaryIntensity));
  }

  if (physiology.zoneMatch === false && physiology.hrZone !== null && physiology.plannedZone) {
    const actualZoneLabel = physiology.hrZone !== null ? zoneLabel(physiology.hrZone) : '未知';
    risks.push(`实际训练区间 (${actualZoneLabel}) 偏离计划要求 (${physiology.plannedZone})`);
  }

  return risks;
}

function buildPhysiologyHighlights(
  workouts: PlannedWorkout[],
  activities: NormalizedActivity[],
  physiology: PhysiologyMetrics | null,
): string[] {
  if (!physiology) return [];
  const highlights: string[] = [];
  const primaryIntensity = workouts.find((w) => !REST_SPORTS.has(w.sport))?.intensity ?? 'medium';

  for (const a of activities) {
    const te = evaluateTrainingEffect(a, primaryIntensity);
    if (te.match && te.note) highlights.push(te.note);
  }

  if (physiology.zoneMatch === true && physiology.hrZone !== null) {
    highlights.push(`心率区间 ${zoneLabel(physiology.hrZone)} 与计划匹配`);
  }

  if (physiology.tss !== null && physiology.intensityFactor !== null) {
    highlights.push(`骑行 IF=${physiology.intensityFactor.toFixed(2)}，TSS=${physiology.tss}`);
  }

  return highlights;
}

function buildPhysiologySuggestions(
  workouts: PlannedWorkout[],
  activities: NormalizedActivity[],
  physiology: PhysiologyMetrics | null,
): string[] {
  if (!physiology) return [];
  const suggestions: string[] = [];
  const primaryIntensity = workouts.find((w) => !REST_SPORTS.has(w.sport))?.intensity ?? 'medium';

  if (primaryIntensity === 'low' && physiology.hrZone !== null && physiology.hrZone >= 3) {
    suggestions.push('轻松日保持 Zone 1-2 有助于长期适应（Seiler 极化训练原则）');
  }

  for (const a of activities) {
    const te = evaluateTrainingEffect(a, primaryIntensity);
    if (!te.match && te.note) suggestions.push(te.note);
  }

  if (physiology.edwardsTRIMP !== null && physiology.edwardsTRIMP > 400) {
    suggestions.push('单日 TRIMP 偏高，注意安排充足恢复');
  }

  return suggestions;
}
