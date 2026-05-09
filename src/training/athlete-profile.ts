// buildAthleteProfile — pure derivation of the user's capability picture
// from their last 28-56 days of normalized activities.
//
// Output shape MUST match the `athleteProfile.*` paths consumed by U5
// templates (see api/src/training/templates/variables.ts header). Any
// metric we can't derive confidently is OMITTED, never zeroed.
//
// No I/O, no LLM, no DB.

import type { NormalizedActivity, NormalizedSport } from './activity-normalizer.js';
import type { QualityResult } from './activity-quality.js';
import { classifyStimulus } from './recent-state.js';

export type Confidence = 'low' | 'medium' | 'high';

export interface AthleteProfileHeartRate {
  recoveryRange: [number, number];
  aerobicLowRange: [number, number];
  aerobicRange: [number, number];
  tempoRange: [number, number];
  thresholdRange: [number, number];
  vo2CapRange: [number, number];
}

export interface AthleteProfileRunning {
  available: boolean;
  confidence: Confidence;
  easyPaceSecPerKm?: number;
  longPaceSecPerKm?: number;
  tempoPaceSecPerKm?: number;
  thresholdPaceSecPerKm?: number;
  intervalPaceSecPerKm?: number;
  vo2PaceSecPerKm?: number;
  racePaceSecPerKm?: number;
}

export interface AthleteProfileCycling {
  available: boolean;
  confidence: Confidence;
  ftpWatts?: number;
  enduranceHrRange?: [number, number];
  tempoHrRange?: [number, number];
  thresholdHrRange?: [number, number];
  vo2HrCapRange?: [number, number];
}

export interface AthleteProfileSwimming {
  available: boolean;
  confidence: Confidence;
  poolLengthM?: 25 | 50 | null;
  easyPaceSecPer100m?: number;
  aerobicPaceSecPer100m?: number;
  endurancePaceSecPer100m?: number;
  cssPaceSecPer100m?: number;
  vo2PaceSecPer100m?: number;
  sprintPaceSecPer100m?: number;
}

export interface AthleteProfile {
  heartRate: AthleteProfileHeartRate | null;
  running: AthleteProfileRunning;
  cycling: AthleteProfileCycling;
  swimming: AthleteProfileSwimming;
  injuries: string[];
  experienceLevel: 'beginner' | 'intermediate' | 'advanced';
}

export interface BuildProfileInput {
  activities: NormalizedActivity[]; // last 28-56 days
  qualities: Map<string, QualityResult>;
  request: {
    injuries?: string;
    raceDate?: string | null;
    goalDistance?: string | null;
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function buildAthleteProfile(input: BuildProfileInput): AthleteProfile {
  const reliable = input.activities.filter((a) => isReliable(a, input.qualities));

  const heartRate = deriveHeartRate(reliable);

  const running = deriveRunning(reliable, heartRate);
  const cycling = deriveCycling(reliable, heartRate);
  const swimming = deriveSwimming(reliable);

  const injuries = parseInjuries(input.request.injuries);
  const experienceLevel = deriveExperienceLevel({
    activities: input.activities,
    running,
    cycling,
    swimming,
    haveMaxHr: heartRate !== null,
  });

  return {
    heartRate,
    running,
    cycling,
    swimming,
    injuries,
    experienceLevel,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isReliable(
  a: NormalizedActivity,
  qualities: Map<string, QualityResult>,
): boolean {
  const q = qualities.get(a.id);
  return q ? q.confidence !== 'low' : true;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function withinDays(a: NormalizedActivity, days: number, asOf?: Date): boolean {
  if (!a.startTimeLocal) return false;
  const now = asOf?.getTime() ?? Date.now();
  return now - a.startTimeLocal.getTime() <= days * DAY_MS;
}

function bucketConfidence(reliableCount: number): Confidence {
  if (reliableCount >= 6) return 'high';
  if (reliableCount >= 2) return 'medium';
  return 'low';
}

function clampPair(low: number, high: number): [number, number] {
  return [Math.round(low), Math.round(high)];
}

// ---------------------------------------------------------------------------
// Heart-rate zone derivation
// ---------------------------------------------------------------------------
// Strategy:
//   - Estimate maxHr as max of (observed peak HR, label-based threshold + 12).
//   - Anchor zones as percentages of maxHr (Karvonen-lite without RHR data,
//     since we don't have a resting HR feed). The percentages mirror the
//     cofounder spec's textbook bands.
//   - Need at least 3 reliable activities WITH HR to attempt this. Otherwise
//     return null (templates that need HR will downgrade or skip).

function deriveHeartRate(
  reliable: NormalizedActivity[],
): AthleteProfileHeartRate | null {
  const withHr = reliable.filter((a) => a.averageHr !== null && a.averageHr > 0);
  if (withHr.length < 3) return null;

  // Best-effort maxHr estimate. Garmin doesn't always expose true maxHr in
  // average-only fields; we use the highest observed average and bump it a
  // bit. If a recent threshold-labelled activity averaged 165, true max is
  // probably around 180.
  let observedMax = 0;
  let thresholdHrSeen: number | null = null;
  for (const a of withHr) {
    const hr = a.averageHr as number;
    if (hr > observedMax) observedMax = hr;
    const stim = classifyStimulus(a);
    if (stim === 'threshold' && (thresholdHrSeen === null || hr > thresholdHrSeen)) {
      thresholdHrSeen = hr;
    }
  }
  if (observedMax <= 0) return null;

  const inferredFromThreshold =
    thresholdHrSeen !== null ? Math.round(thresholdHrSeen / 0.92) : 0;
  const maxHr = Math.max(observedMax + 5, inferredFromThreshold, 160);

  // Percentage anchors — chosen to align with how cofounder examples in the
  // spec are quoted (e.g. recovery 110-128, aerobic 132-146, threshold
  // 160-170, vo2 cap < ~95% maxHr).
  const pct = (low: number, high: number): [number, number] =>
    clampPair(maxHr * low, maxHr * high);

  return {
    recoveryRange: pct(0.55, 0.7),
    aerobicLowRange: pct(0.7, 0.78),
    aerobicRange: pct(0.74, 0.82),
    tempoRange: pct(0.82, 0.88),
    thresholdRange: pct(0.88, 0.93),
    vo2CapRange: pct(0.92, 0.97),
  };
}

// ---------------------------------------------------------------------------
// Running derivation
// ---------------------------------------------------------------------------

function deriveRunning(
  reliable: NormalizedActivity[],
  hr: AthleteProfileHeartRate | null,
): AthleteProfileRunning {
  const runs = reliable.filter(
    (a) => a.sport === 'running' && a.averagePaceSecPerKm !== null,
  );
  const confidence = bucketConfidence(runs.length);

  const profile: AthleteProfileRunning = {
    available: runs.length > 0,
    confidence,
  };

  if (runs.length === 0) return profile;

  // Bucket by stimulus.
  const byStim = new Map<string, number[]>();
  for (const r of runs) {
    const stim = classifyStimulus(r);
    const bucket = byStim.get(stim) ?? [];
    bucket.push(r.averagePaceSecPerKm as number);
    byStim.set(stim, bucket);
  }

  const easyPool = [
    ...(byStim.get('aerobic') ?? []),
    ...(byStim.get('recovery') ?? []),
    ...(byStim.get('long_endurance') ?? []),
  ];
  const easyMedian = median(easyPool);

  // Threshold from labelled threshold sessions or fastest sustained efforts.
  const thresholdPool = byStim.get('threshold') ?? [];
  let thresholdMedian = median(thresholdPool);
  if (thresholdMedian === null) {
    // Fallback: fastest 80% of mid-distance steady-state efforts (20-40 min,
    // distance >= 4 km) — proxies a tempo/threshold pace.
    const candidates = runs
      .filter((r) => r.durationMin >= 20 && r.durationMin <= 50 && r.distanceKm >= 4)
      .map((r) => r.averagePaceSecPerKm as number)
      .sort((a, b) => a - b);
    if (candidates.length >= 2) {
      const cutoff = Math.max(1, Math.floor(candidates.length * 0.8));
      thresholdMedian = median(candidates.slice(0, cutoff));
    }
  }

  // Tempo: spec says +15-30 s/km off threshold, or labelled tempo runs.
  const tempoPool = byStim.get('tempo') ?? [];
  let tempoMedian = median(tempoPool);
  if (tempoMedian === null && thresholdMedian !== null) {
    tempoMedian = thresholdMedian + 22;
  }

  // VO2: from labelled vo2max efforts, or threshold - 35.
  const vo2Pool = byStim.get('vo2max') ?? [];
  let vo2Median = median(vo2Pool);
  if (vo2Median === null && thresholdMedian !== null) {
    vo2Median = thresholdMedian - 35;
  }

  // Easy fallback: thresholdMedian + 70 if we have threshold but no easy.
  const easyResolved =
    easyMedian !== null
      ? easyMedian
      : thresholdMedian !== null
        ? thresholdMedian + 70
        : null;

  if (easyResolved !== null) {
    profile.easyPaceSecPerKm = Math.round(easyResolved);
    profile.longPaceSecPerKm = Math.round(easyResolved + 20);
  }
  if (thresholdMedian !== null) {
    profile.thresholdPaceSecPerKm = Math.round(thresholdMedian);
    profile.intervalPaceSecPerKm = Math.round(thresholdMedian - 20);
  }
  if (tempoMedian !== null) {
    profile.tempoPaceSecPerKm = Math.round(tempoMedian);
  }
  if (vo2Median !== null) {
    profile.vo2PaceSecPerKm = Math.round(vo2Median);
  }
  // Race pace: only if we have threshold; treat as threshold + 5 s/km
  // (a reasonable open-distance race target). We deliberately do not derive
  // this from request.goalDistance — the parameterizer (U7) is responsible
  // for race-distance specific logic. Touch HR-only once to keep symbol used.
  void hr;
  if (thresholdMedian !== null) {
    profile.racePaceSecPerKm = Math.round(thresholdMedian + 5);
  }

  return profile;
}

// ---------------------------------------------------------------------------
// Cycling derivation
// ---------------------------------------------------------------------------

function deriveCycling(
  reliable: NormalizedActivity[],
  hr: AthleteProfileHeartRate | null,
): AthleteProfileCycling {
  const rides = reliable.filter((a) => a.sport === 'cycling');
  const confidence = bucketConfidence(rides.length);

  const profile: AthleteProfileCycling = {
    available: rides.length > 0,
    confidence,
  };

  if (rides.length === 0) return profile;

  // FTP estimate — prefer normalizedPower from a labelled threshold ride;
  // fall back to 95% of the highest 20-min effort's normalizedPower; finally
  // fall back to mean averagePower of threshold-labelled rides.
  let ftp: number | null = null;
  const thresholdRides = rides.filter((r) => classifyStimulus(r) === 'threshold');
  const npFromThreshold = thresholdRides
    .map((r) => r.normalizedPower)
    .filter((n): n is number => n !== null && n > 0);
  if (npFromThreshold.length > 0) {
    ftp = Math.round(median(npFromThreshold) as number);
  } else {
    const candidate20 = rides
      .filter(
        (r) =>
          r.durationMin >= 18 &&
          r.durationMin <= 40 &&
          (r.normalizedPower ?? 0) > 0,
      )
      .map((r) => r.normalizedPower as number)
      .sort((a, b) => b - a);
    if (candidate20.length > 0) {
      ftp = Math.round(candidate20[0] * 0.95);
    } else {
      const apFromThreshold = thresholdRides
        .map((r) => r.averagePower)
        .filter((n): n is number => n !== null && n > 0);
      if (apFromThreshold.length > 0) {
        ftp = Math.round(median(apFromThreshold) as number);
      }
    }
  }
  if (ftp !== null && ftp > 0) {
    profile.ftpWatts = ftp;
  }

  // HR ranges: borrow the global heartRate ranges if available — cycling
  // shares the cardiovascular system. Templates already alias bike HR to
  // global HR per the variable description tables.
  if (hr) {
    profile.enduranceHrRange = hr.aerobicRange;
    profile.tempoHrRange = hr.tempoRange;
    profile.thresholdHrRange = hr.thresholdRange;
    profile.vo2HrCapRange = hr.vo2CapRange;
  }

  return profile;
}

// ---------------------------------------------------------------------------
// Swimming derivation
// ---------------------------------------------------------------------------

function deriveSwimming(reliable: NormalizedActivity[]): AthleteProfileSwimming {
  const swims = reliable.filter(
    (a) => a.sport === 'swimming' && a.averagePaceSecPer100m !== null,
  );
  const confidence = bucketConfidence(swims.length);

  const profile: AthleteProfileSwimming = {
    available: swims.length > 0,
    confidence,
  };

  if (swims.length === 0) return profile;

  // Pool length: infer from distance pattern. If the median distance is a
  // multiple of 25 (and not also a multiple of 50), call it 25. If clearly
  // multiples of 50, call it 50. Otherwise null.
  const distances = swims
    .map((s) => Math.round(s.distanceKm * 1000))
    .filter((d) => d > 0);
  let poolLengthM: 25 | 50 | null = null;
  if (distances.length >= 3) {
    const mod50 = distances.filter((d) => d % 50 === 0).length;
    const mod25 = distances.filter((d) => d % 25 === 0).length;
    const ratio50 = mod50 / distances.length;
    const ratio25 = mod25 / distances.length;
    if (ratio50 >= 0.7) poolLengthM = 50;
    else if (ratio25 >= 0.7) poolLengthM = 25;
  }
  profile.poolLengthM = poolLengthM;

  // CSS: from labelled threshold sessions, else fastest 200m segment proxy
  // (we don't have segments, so proxy = fastest reliable swim's pace).
  const cssCandidates = swims
    .filter((s) => {
      const stim = classifyStimulus(s);
      return stim === 'threshold' || stim === 'tempo';
    })
    .map((s) => s.averagePaceSecPer100m as number);
  let css = median(cssCandidates);
  if (css === null) {
    const allPaces = swims
      .map((s) => s.averagePaceSecPer100m as number)
      .sort((a, b) => a - b);
    css = allPaces[0]; // fastest as best CSS estimate
  }
  if (css === null || !Number.isFinite(css) || css <= 0) {
    return profile;
  }

  profile.cssPaceSecPer100m = Math.round(css);
  profile.easyPaceSecPer100m = Math.round(css + 18);
  profile.aerobicPaceSecPer100m = Math.round(css + 12);
  profile.endurancePaceSecPer100m = Math.round(css + 14);
  profile.vo2PaceSecPer100m = Math.round(css - 5);
  profile.sprintPaceSecPer100m = Math.round(css - 14);

  return profile;
}

// ---------------------------------------------------------------------------
// Injuries / experience
// ---------------------------------------------------------------------------

function parseInjuries(text: string | undefined): string[] {
  if (!text) return [];
  // Split on Chinese / English commas, semicolons, and newlines.
  const parts = text
    .split(/[,，;；\n]+/)
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
  // Dedupe.
  return Array.from(new Set(parts));
}

interface ExperienceInput {
  activities: NormalizedActivity[];
  running: AthleteProfileRunning;
  cycling: AthleteProfileCycling;
  swimming: AthleteProfileSwimming;
  haveMaxHr: boolean;
}

function deriveExperienceLevel(
  input: ExperienceInput,
): 'beginner' | 'intermediate' | 'advanced' {
  const sports: NormalizedSport[] = ['running', 'cycling', 'swimming'];
  void sports;
  const confidences: Confidence[] = [
    input.running.confidence,
    input.cycling.confidence,
    input.swimming.confidence,
  ];
  const anyHigh = confidences.some((c) => c === 'high');
  const anyMedium = confidences.some((c) => c === 'medium' || c === 'high');

  // Total sessions over the input window (caller passes ~56d worth).
  const totalSessions = input.activities.length;

  if (anyHigh && totalSessions >= 30 && input.haveMaxHr) return 'advanced';
  if (anyMedium) return 'intermediate';
  return 'beginner';
}
