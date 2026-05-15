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
import type {
  GarminHeartRateZoneSet,
  GarminPhysiologyMetrics,
} from '../garmin/fetch-recent.js';

export type Confidence = 'low' | 'medium' | 'high';

export interface AthleteProfileHeartRate {
  maxHeartRate?: number | null;
  recoveryRange: [number, number];
  aerobicLowRange: [number, number];
  aerobicRange: [number, number];
  zone2Range?: [number, number];
  tempoRange: [number, number];
  thresholdRange: [number, number];
  vo2CapRange: [number, number];
  source?: 'garmin_zones' | 'garmin_or_samples' | 'max_hr_estimate';
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
  vo2Max?: number;
  runningEconomy?: {
    groundContactTimeMs?: number;
    verticalOscillationCm?: number;
    verticalRatio?: number;
    cadenceSpm?: number;
    assessment: 'good' | 'average' | 'needs_work' | 'unknown';
  };
  evidence?: CapabilityEvidence;
}

type RunningEconomy = NonNullable<AthleteProfileRunning['runningEconomy']>;

export interface AthleteProfileCycling {
  available: boolean;
  confidence: Confidence;
  ftpWatts?: number;
  ftpSource?:
    | 'garmin_activity'
    | 'garmin_profile'
    | 'estimated_20min_power'
    | 'estimated_threshold_power';
  vo2Max?: number;
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
  cssSource?: 'garmin_critical_swim_speed' | 'activity_samples';
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

export interface CapabilityEvidenceSample {
  date: string | null;
  activityId: string | number;
  distanceKm: number;
  durationMin: number;
  paceSecPerKm?: number;
  avgHr: number | null;
  maxHr: number | null;
  averagePower: number | null;
  normalizedPower: number | null;
  averageCadence: number | null;
  groundContactTime: number | null;
  verticalOscillation: number | null;
  verticalRatio: number | null;
  vo2Max: number | null;
  lactateThresholdHr: number | null;
  lactateThresholdPaceSecPerKm: number | null;
  trainingLoad: number | null;
  aerobicTrainingEffect: number | null;
  anaerobicTrainingEffect: number | null;
  trainingStatus: string | null;
  hrvStatus: string | null;
  sleepDurationHours: number | null;
  sleepScore: number | null;
  recoveryTimeHours: number | null;
  stimulus: string;
  quality: Confidence;
  included: boolean;
  reason: string;
}

export interface CapabilityEstimateEvidence {
  value?: number;
  confidence: Confidence;
  method: string;
  samples: CapabilityEvidenceSample[];
  warnings: string[];
}

export interface CapabilityEvidence {
  easyPace?: CapabilityEstimateEvidence;
  thresholdPace?: CapabilityEstimateEvidence;
  notes: string[];
}

export interface BuildProfileInput {
  activities: NormalizedActivity[]; // last 28-56 days
  qualities: Map<string, QualityResult>;
  physiology?: GarminPhysiologyMetrics | null;
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

  const heartRate = deriveHeartRate(reliable, input.physiology);

  const running = deriveRunning(
    input.activities,
    input.qualities,
    heartRate,
    input.physiology,
  );
  const calibratedHeartRate =
    heartRate?.source === 'garmin_zones'
      ? heartRate
      : calibrateHeartRateFromRunning(heartRate, running);
  const cycling = deriveCycling(reliable, calibratedHeartRate, input.physiology);
  const swimming = deriveSwimming(reliable, input.physiology);

  const injuries = parseInjuries(input.request.injuries);
  const experienceLevel = deriveExperienceLevel({
    activities: input.activities,
    running,
    cycling,
    swimming,
    haveMaxHr: heartRate !== null,
  });

  return {
    heartRate: calibratedHeartRate,
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

function percentile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * q)),
  );
  return sorted[idx];
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

function validPositive(value: number | null | undefined): number | null {
  return value !== null &&
    value !== undefined &&
    Number.isFinite(value) &&
    value > 0
    ? value
    : null;
}

function qualityOf(
  activity: NormalizedActivity,
  qualities: Map<string, QualityResult>,
): Confidence {
  return qualities.get(activity.id)?.confidence ?? 'high';
}

function firstIsoDate(activity: NormalizedActivity): string | null {
  return activity.startTimeLocal
    ? activity.startTimeLocal.toISOString().slice(0, 10)
    : null;
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
  physiology?: GarminPhysiologyMetrics | null,
): AthleteProfileHeartRate | null {
  const withHr = reliable.filter((a) => a.averageHr !== null && a.averageHr > 0);
  const profileZones = deriveHeartRateFromGarminZoneSet(
    physiology?.heartRateZones.default ?? null,
  );
  if (profileZones) return profileZones;

  const garminZones = deriveGarminHeartRateZones(reliable);
  if (garminZones) return garminZones;

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
    if (a.maxHr !== null && a.maxHr > observedMax) observedMax = a.maxHr;
    const stim = classifyStimulus(a);
    if (stim === 'threshold' && (thresholdHrSeen === null || hr > thresholdHrSeen)) {
      thresholdHrSeen = hr;
    }
    if (
      a.lactateThresholdHr !== null &&
      (thresholdHrSeen === null || a.lactateThresholdHr > thresholdHrSeen)
    ) {
      thresholdHrSeen = a.lactateThresholdHr;
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
  const recoveryRange = pct(0.55, 0.7);
  const zone2Range = pct(0.6, 0.7);

  return {
    recoveryRange,
    aerobicLowRange: pct(0.7, 0.78),
    aerobicRange: pct(0.74, 0.82),
    zone2Range,
    tempoRange: pct(0.82, 0.88),
    thresholdRange: pct(0.88, 0.93),
    vo2CapRange: pct(0.92, 0.97),
    source: 'max_hr_estimate',
  };
}

function deriveHeartRateFromGarminZoneSet(
  zoneSet: GarminHeartRateZoneSet | null | undefined,
): AthleteProfileHeartRate | null {
  if (!zoneSet || zoneSet.zones.length < 5) return null;
  const [z1, z2, z3, z4, z5] = zoneSet.zones;
  if (!z2 || !z3 || !z4 || !z5) return null;
  return {
    maxHeartRate: zoneSet.maxHeartRate,
    recoveryRange: z1 ?? [Math.max(80, z2[0] - 20), z2[0] - 1],
    aerobicLowRange: z2,
    aerobicRange: z2,
    zone2Range: z2,
    tempoRange: z3,
    thresholdRange: z4,
    vo2CapRange: z5,
    source: 'garmin_zones',
  };
}

function deriveGarminHeartRateZones(
  activities: NormalizedActivity[],
): AthleteProfileHeartRate | null {
  const zoneSets = activities
    .map((a) => a.heartRateZones)
    .filter((zones) => zones.length >= 5);
  if (zoneSets.length === 0) return null;

  const zoneAt = (idx: number): [number, number] | null => {
    const lows: number[] = [];
    const highs: number[] = [];
    for (const zones of zoneSets) {
      const zone = zones[idx];
      if (!zone) continue;
      lows.push(zone[0]);
      highs.push(zone[1]);
    }
    const low = median(lows);
    const high = median(highs);
    return low !== null && high !== null && high > low
      ? [Math.round(low), Math.round(high)]
      : null;
  };

  const z1 = zoneAt(0);
  const z2 = zoneAt(1);
  const z3 = zoneAt(2);
  const z4 = zoneAt(3);
  const z5 = zoneAt(4);
  if (!z2 || !z3 || !z4 || !z5) return null;

  const observedMax = median(
    activities
      .map((a) => a.maxHr)
      .filter((n): n is number => n !== null && n > 0),
  );

  return {
    maxHeartRate: observedMax ? Math.round(observedMax) : null,
    recoveryRange: z1 ?? [Math.max(80, z2[0] - 20), z2[0]],
    aerobicLowRange: z2,
    aerobicRange: z2,
    zone2Range: z2,
    tempoRange: z3,
    thresholdRange: z4,
    vo2CapRange: z5,
    source: 'garmin_zones',
  };
}

function calibrateHeartRateFromRunning(
  hr: AthleteProfileHeartRate | null,
  running: AthleteProfileRunning,
): AthleteProfileHeartRate | null {
  if (!hr) return null;
  if (hr.source === 'garmin_zones') return hr;
  const samples = running.evidence?.easyPace?.samples.filter((s) => s.included) ?? [];
  const hrs = samples
    .map((s) => s.avgHr)
    .filter((n): n is number => n !== null && n > 0)
    .sort((a, b) => a - b);
  if (hrs.length < 3) return hr;

  // Treat the lower part of recent reliable easy / LSD samples as a practical
  // Zone 2 hint, but never let it push low-intensity prescriptions above the
  // conservative max-HR Zone 2 cap. Garmin-labelled "aerobic" activities can
  // still include tempo-ish work for some users.
  const sampleLow = Math.round(percentile(hrs, 0.2) ?? hrs[0]);
  const sampleHigh = Math.round(percentile(hrs, 0.55) ?? hrs[hrs.length - 1]);
  const conservativeHigh = hr.zone2Range?.[1] ?? hr.recoveryRange[1];
  const high = Math.max(103, Math.min(sampleHigh, conservativeHigh));
  const low =
    sampleLow < high - 8
      ? Math.max(95, sampleLow)
      : Math.max(95, high - 19);
  const zone2: [number, number] = [low, high];

  return {
    ...hr,
    recoveryRange: [Math.max(80, low - 30), high],
    aerobicLowRange: zone2,
    aerobicRange: zone2,
    zone2Range: zone2,
    source: 'garmin_or_samples',
  };
}

// ---------------------------------------------------------------------------
// Running derivation
// ---------------------------------------------------------------------------

function deriveRunning(
  activities: NormalizedActivity[],
  qualities: Map<string, QualityResult>,
  hr: AthleteProfileHeartRate | null,
  physiology?: GarminPhysiologyMetrics | null,
): AthleteProfileRunning {
  const allRuns = activities.filter(
    (a) => a.sport === 'running' && a.averagePaceSecPerKm !== null,
  );
  const runs = allRuns.filter((a) => qualityOf(a, qualities) !== 'low');
  const confidence = bucketConfidence(runs.length);

  const profile: AthleteProfileRunning = {
    available: allRuns.length > 0,
    confidence,
  };

  if (allRuns.length === 0) return profile;
  if (runs.length === 0) {
    profile.evidence = {
      notes: ['所有近期跑步都被判为低可信，未输出配速能力。'],
      easyPace: {
        confidence: 'low',
        method: 'excluded_low_quality_runs',
        samples: allRuns.slice(0, 8).map((r) =>
          buildRunningEvidenceSample(r, qualities, false, '低可信活动，未纳入能力估计'),
        ),
        warnings: ['no_reliable_running_samples'],
      },
    };
    return profile;
  }

  // Bucket by stimulus.
  const byStim = new Map<string, number[]>();
  for (const r of runs) {
    const stim = classifyStimulus(r);
    const bucket = byStim.get(stim) ?? [];
    bucket.push(r.averagePaceSecPerKm as number);
    byStim.set(stim, bucket);
  }

  // Threshold from labelled threshold sessions or fastest sustained efforts.
  const garminThresholds = runs
    .map((r) => r.lactateThresholdPaceSecPerKm)
    .filter((n): n is number => n !== null && n > 0);
  const thresholdPool = byStim.get('threshold') ?? [];
  let thresholdMedian = median(garminThresholds) ?? median(thresholdPool);
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

  const easyCandidates = buildEasyRunningCandidates(runs, qualities, hr, thresholdMedian);
  const easyWarnings: string[] = [];
  let easyResolved = percentile(
    easyCandidates.filter((s) => s.included).map((s) => s.pace),
    0.65,
  );

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

  // Easy fallback and Firstbeat-inspired sanity: easy pace must be clearly
  // slower than threshold. If Garmin-labelled "aerobic" samples are too close
  // to threshold, they likely represent tempo-ish work, optimistic labels, or
  // non-representative data. Prefer a conservative threshold-derived range.
  if (easyResolved === null && thresholdMedian !== null) {
    easyResolved = thresholdMedian + 75;
    easyWarnings.push('easy_fallback_from_threshold_plus_75s');
  }
  if (
    easyResolved !== null &&
    thresholdMedian !== null &&
    easyResolved - thresholdMedian < 45
  ) {
    easyResolved = thresholdMedian + 75;
    easyWarnings.push('easy_too_close_to_threshold_adjusted_plus_75s');
  }

  const garminVo2Max = validPositive(physiology?.vo2MaxRunning);
  if (garminVo2Max !== null) {
    profile.vo2Max = Math.round(garminVo2Max);
  } else {
    const vo2Values = runs
      .map((r) => r.vo2Max)
      .filter((n): n is number => n !== null && n > 0);
    const vo2Max = median(vo2Values);
    if (vo2Max !== null) {
      profile.vo2Max = Math.round(vo2Max);
    }
  }

  const runningEconomy = deriveRunningEconomy(runs);
  profile.runningEconomy = runningEconomy;

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

  const easySamples = easyCandidates
    .sort((a, b) => Number(b.included) - Number(a.included))
    .slice(0, 10)
    .map((s) =>
      buildRunningEvidenceSample(s.activity, qualities, s.included, s.reason),
    );
  const thresholdSamples = runs
    .slice()
    .filter((r) => {
      const stim = classifyStimulus(r);
      return (
        stim === 'threshold' ||
        r.lactateThresholdPaceSecPerKm !== null ||
        (r.durationMin >= 20 && r.durationMin <= 50 && r.distanceKm >= 4)
      );
    })
    .sort((a, b) => (a.averagePaceSecPerKm ?? 9999) - (b.averagePaceSecPerKm ?? 9999))
    .slice(0, 8)
    .map((r) =>
      buildRunningEvidenceSample(r, qualities, true, '阈值/稳态能力候选样本'),
    );

  profile.evidence = {
    notes: buildRunningEvidenceNotes({
      runs,
      excludedCount: allRuns.length - runs.length,
      easyAdjusted: easyWarnings.length > 0,
      economy: runningEconomy.assessment,
      vo2Max: profile.vo2Max,
    }),
    easyPace: {
      value: profile.easyPaceSecPerKm,
      confidence: easySamples.filter((s) => s.included).length >= 3 ? confidence : 'low',
      method: 'recent_hr_load_quality_weighted_samples_with_threshold_gap_guard',
      samples: easySamples,
      warnings: easyWarnings,
    },
    thresholdPace: {
      value: profile.thresholdPaceSecPerKm,
      confidence: thresholdSamples.length >= 2 ? confidence : 'low',
      method:
        garminThresholds.length > 0
          ? 'garmin_lactate_threshold_preferred'
          : 'threshold_label_or_fast_sustained_efforts',
      samples: thresholdSamples,
      warnings: [],
    },
  };

  return profile;
}

interface EasyCandidate {
  activity: NormalizedActivity;
  pace: number;
  included: boolean;
  reason: string;
}

function buildEasyRunningCandidates(
  runs: NormalizedActivity[],
  qualities: Map<string, QualityResult>,
  hr: AthleteProfileHeartRate | null,
  thresholdPace: number | null,
): EasyCandidate[] {
  const out: EasyCandidate[] = [];
  for (const r of runs) {
    const pace = r.averagePaceSecPerKm;
    if (pace === null) continue;
    const stim = classifyStimulus(r);
    const avgHr = r.averageHr;
    const quality = qualityOf(r, qualities);
    const inHrEasy =
      hr !== null &&
      avgHr !== null &&
      avgHr >= hr.recoveryRange[0] &&
      avgHr <= hr.aerobicRange[1];
    const garminEasy =
      stim === 'aerobic' || stim === 'recovery' || stim === 'long_endurance';
    const highIntensityStimulus =
      stim === 'tempo' ||
      stim === 'threshold' ||
      stim === 'vo2max' ||
      stim === 'anaerobic';

    let included =
      quality !== 'low' &&
      r.durationMin >= 15 &&
      r.distanceKm >= 2 &&
      !highIntensityStimulus &&
      (garminEasy || inHrEasy);
    let reason = included
      ? '近期可靠低强度/有氧样本'
      : '不满足低强度有氧样本条件';

    if (thresholdPace !== null && pace - thresholdPace < 35) {
      included = false;
      reason = '配速过于接近阈值配速，未作为有氧能力样本';
    }
    if (avgHr !== null && hr !== null && avgHr > hr.tempoRange[0]) {
      included = false;
      reason = '平均心率进入 tempo 或更高区间，未作为有氧样本';
    }
    out.push({ activity: r, pace, included, reason });
  }
  return out;
}

function buildRunningEvidenceSample(
  activity: NormalizedActivity,
  qualities: Map<string, QualityResult>,
  included: boolean,
  reason: string,
): CapabilityEvidenceSample {
  return {
    date: firstIsoDate(activity),
    activityId: activity.activityId,
    distanceKm: activity.distanceKm,
    durationMin: activity.durationMin,
    paceSecPerKm: activity.averagePaceSecPerKm ?? undefined,
    avgHr: activity.averageHr,
    maxHr: activity.maxHr,
    averagePower: activity.averagePower,
    normalizedPower: activity.normalizedPower,
    averageCadence: activity.averageCadence,
    groundContactTime: activity.groundContactTime,
    verticalOscillation: normalizeVerticalOscillationCm(activity.verticalOscillation),
    verticalRatio: activity.verticalRatio,
    vo2Max: activity.vo2Max,
    lactateThresholdHr: activity.lactateThresholdHr,
    lactateThresholdPaceSecPerKm: activity.lactateThresholdPaceSecPerKm,
    trainingLoad: activity.trainingLoad,
    aerobicTrainingEffect: activity.aerobicTrainingEffect,
    anaerobicTrainingEffect: activity.anaerobicTrainingEffect,
    trainingStatus: activity.trainingStatus,
    hrvStatus: activity.hrvStatus,
    sleepDurationHours: activity.sleepDurationHours,
    sleepScore: activity.sleepScore,
    recoveryTimeHours: activity.recoveryTimeHours,
    stimulus: classifyStimulus(activity),
    quality: qualityOf(activity, qualities),
    included,
    reason,
  };
}

function deriveRunningEconomy(
  runs: NormalizedActivity[],
): RunningEconomy {
  const gct = median(
    runs
      .map((r) => r.groundContactTime)
      .filter((n): n is number => n !== null && n > 0),
  );
  const vo = median(
    runs
      .map((r) => normalizeVerticalOscillationCm(r.verticalOscillation))
      .filter((n): n is number => n !== null && n > 0),
  );
  const vr = median(
    runs
      .map((r) => r.verticalRatio)
      .filter((n): n is number => n !== null && n > 0),
  );
  const cadence = median(
    runs
      .map((r) => r.averageCadence)
      .filter((n): n is number => n !== null && n > 0),
  );

  let assessment: 'good' | 'average' | 'needs_work' | 'unknown' = 'unknown';
  if (gct !== null || vo !== null || vr !== null || cadence !== null) {
    let penalty = 0;
    if (gct !== null && gct > 300) penalty += 1;
    if (gct !== null && gct > 330) penalty += 1;
    if (vo !== null && vo > 10.5) penalty += 1;
    if (vr !== null && vr > 10) penalty += 1;
    if (cadence !== null && cadence < 160) penalty += 1;
    assessment = penalty >= 2 ? 'needs_work' : penalty === 1 ? 'average' : 'good';
  }

  return {
    ...(gct !== null ? { groundContactTimeMs: Math.round(gct) } : {}),
    ...(vo !== null ? { verticalOscillationCm: Math.round(vo * 10) / 10 } : {}),
    ...(vr !== null ? { verticalRatio: Math.round(vr * 10) / 10 } : {}),
    ...(cadence !== null ? { cadenceSpm: Math.round(cadence) } : {}),
    assessment,
  };
}

function normalizeVerticalOscillationCm(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  return value > 30 ? value / 10 : value;
}

function buildRunningEvidenceNotes(args: {
  runs: NormalizedActivity[];
  excludedCount: number;
  easyAdjusted: boolean;
  economy: 'good' | 'average' | 'needs_work' | 'unknown';
  vo2Max?: number;
}): string[] {
  const notes = [
    `使用 ${args.runs.length} 条非低可信跑步样本建立跑步画像。`,
  ];
  if (args.excludedCount > 0) {
    notes.push(`${args.excludedCount} 条跑步因质量过低被排除。`);
  }
  if (args.easyAdjusted) {
    notes.push('有氧配速样本过于接近阈值配速，已按阈值差距规则保守修正。');
  }
  if (args.economy === 'needs_work') {
    notes.push('跑姿经济性指标偏弱，配速处方应优先保守。');
  }
  if (args.vo2Max !== undefined) {
    notes.push(`Garmin VO2max 参考值约 ${args.vo2Max}。`);
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Cycling derivation
// ---------------------------------------------------------------------------

function deriveCycling(
  reliable: NormalizedActivity[],
  hr: AthleteProfileHeartRate | null,
  physiology?: GarminPhysiologyMetrics | null,
): AthleteProfileCycling {
  const rides = reliable.filter((a) => a.sport === 'cycling');
  const confidence = bucketConfidence(rides.length);

  const profile: AthleteProfileCycling = {
    available: rides.length > 0,
    confidence,
  };

  if (rides.length === 0) return profile;

  const garminCyclingVo2 = validPositive(physiology?.vo2MaxCycling);
  if (garminCyclingVo2 !== null) {
    profile.vo2Max = Math.round(garminCyclingVo2);
  }

  // FTP estimate — prefer Garmin's own functionalThresholdPower from recent
  // ride details/profile, then fall back to 95% of actual 20-min max power.
  // Normalized power is only a last-resort threshold proxy; using it before
  // Garmin FTP materially under-prescribes workouts for users with sensors.
  let ftp: number | null = null;
  let ftpSource: AthleteProfileCycling['ftpSource'] | null = null;
  const garminActivityFtp = rides
    .filter((r) => validPositive(r.functionalThresholdPower) !== null)
    .sort((a, b) => {
      const at = a.startTimeLocal?.getTime() ?? 0;
      const bt = b.startTimeLocal?.getTime() ?? 0;
      return bt - at;
    })
    .map((r) => r.functionalThresholdPower as number);
  if (garminActivityFtp.length > 0) {
    ftp = Math.round(garminActivityFtp[0]);
    ftpSource = 'garmin_activity';
  }
  const garminProfileFtp = validPositive(physiology?.functionalThresholdPower);
  if (ftp === null && garminProfileFtp !== null) {
    ftp = Math.round(garminProfileFtp);
    ftpSource = 'garmin_profile';
  }

  const thresholdRides = rides.filter((r) => classifyStimulus(r) === 'threshold');
  if (ftp === null) {
    const candidate20 = rides
      .map((r) => r.maxPowerTwentyMinutes)
      .filter((n): n is number => n !== null && n > 0)
      .sort((a, b) => b - a);
    if (candidate20.length > 0) {
      ftp = Math.round(candidate20[0] * 0.95);
      ftpSource = 'estimated_20min_power';
    }
  }
  if (ftp === null) {
    const npFromThreshold = thresholdRides
      .map((r) => r.normalizedPower)
      .filter((n): n is number => n !== null && n > 0);
    if (npFromThreshold.length > 0) {
      ftp = Math.round(median(npFromThreshold) as number);
      ftpSource = 'estimated_threshold_power';
    } else {
      const apFromThreshold = thresholdRides
        .map((r) => r.averagePower)
        .filter((n): n is number => n !== null && n > 0);
      if (apFromThreshold.length > 0) {
        ftp = Math.round(median(apFromThreshold) as number);
        ftpSource = 'estimated_threshold_power';
      }
    }
  }
  if (ftp !== null && ftp > 0) {
    profile.ftpWatts = ftp;
    if (ftpSource) profile.ftpSource = ftpSource;
  }

  const cyclingHr =
    deriveHeartRateFromGarminZoneSet(physiology?.heartRateZones.cycling ?? null) ??
    hr;
  if (cyclingHr) {
    profile.enduranceHrRange = cyclingHr.aerobicRange;
    profile.tempoHrRange = cyclingHr.tempoRange;
    profile.thresholdHrRange = cyclingHr.thresholdRange;
    profile.vo2HrCapRange = cyclingHr.vo2CapRange;
  }

  return profile;
}

// ---------------------------------------------------------------------------
// Swimming derivation
// ---------------------------------------------------------------------------

function deriveSwimming(
  reliable: NormalizedActivity[],
  physiology?: GarminPhysiologyMetrics | null,
): AthleteProfileSwimming {
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

  // CSS: prefer Garmin's criticalSwimSpeed when available. It is a profile
  // capability value; average swim pace often includes drills and rests.
  let css = cssPaceFromCriticalSwimSpeed(physiology?.criticalSwimSpeed);
  let cssSource: AthleteProfileSwimming['cssSource'] | null =
    css !== null ? 'garmin_critical_swim_speed' : null;
  if (css === null) {
    const cssCandidates = swims
      .filter((s) => {
        const stim = classifyStimulus(s);
        return stim === 'threshold' || stim === 'tempo';
      })
      .map((s) => s.averagePaceSecPer100m as number);
    css = median(cssCandidates);
    if (css === null) {
      const sustainedPaces = swims
        .filter((s) => s.distanceKm >= 0.8 && s.durationMin >= 15)
        .map((s) => s.averagePaceSecPer100m as number)
        .sort((a, b) => a - b);
      css =
        sustainedPaces.length >= 3
          ? percentile(sustainedPaces, 0.35)
          : median(sustainedPaces);
    }
    cssSource = css !== null ? 'activity_samples' : null;
  }
  if (css === null || !Number.isFinite(css) || css <= 0) {
    return profile;
  }

  profile.cssPaceSecPer100m = Math.round(css);
  if (cssSource) profile.cssSource = cssSource;
  profile.easyPaceSecPer100m = Math.round(css + 18);
  profile.aerobicPaceSecPer100m = Math.round(css + 12);
  profile.endurancePaceSecPer100m = Math.round(css + 14);
  profile.vo2PaceSecPer100m = Math.round(css - 5);
  profile.sprintPaceSecPer100m = Math.round(css - 14);

  return profile;
}

function cssPaceFromCriticalSwimSpeed(value: number | null | undefined): number | null {
  const raw = validPositive(value);
  if (raw === null) return null;
  if (raw >= 400 && raw <= 2500) {
    // Garmin biometricProfile.criticalSwimSpeed is returned as mm/s
    // (for example 855 -> 0.855 m/s -> 117 s/100m).
    return 100000 / raw;
  }
  if (raw >= 40 && raw <= 240) return raw;
  if (raw >= 0.2 && raw <= 3) return 100 / raw;
  return null;
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
