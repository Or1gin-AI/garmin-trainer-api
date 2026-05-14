// classifyActivityQuality — pure detector for unreliable activities.
//
// Translated from cofounder spec "活动可信度判断" (training-plan-generation
// -refactor.md, lines ~220-247). Output is consumed by athlete-profile and
// recent-state derivation to filter low-quality data points.
//
// No I/O, no LLM, no DB.

import type { NormalizedActivity, NormalizedSport } from './activity-normalizer.js';

export type Confidence = 'high' | 'medium' | 'low';

export type QualityFlag =
  | 'no_heart_rate'
  | 'cycling_high_speed_low_hr'
  | 'running_fast_low_hr'
  | 'running_far_above_baseline_low_hr'
  | 'running_power_pace_mismatch'
  | 'running_economy_mismatch'
  | 'distance_without_physiology'
  | 'long_distance_no_training_load'
  | 'speed_inconsistent_with_hr'
  | 'implausible_distance_duration'
  | 'type_benefit_mismatch'
  | 'below_training_signal_threshold'
  | 'above_personal_capacity'
  | 'extreme_distance_low_load';

export interface QualityResult {
  confidence: Confidence;
  flags: QualityFlag[];
}

export interface QualityContext {
  // User's typical cycling avg speed (m/s) over reliable rides — used as the
  // baseline for "speed > 50% above median" detection. Pass null/undefined
  // to disable the personal-baseline check (we still apply the absolute
  // 12 m/s ≈ 43 km/h floor).
  cyclingMedianSpeedMps?: number | null;
  // User's typical recent running pace (s/km). Used to catch transportation
  // or GPS errors that are fast relative to the athlete but do not carry a
  // corresponding cardiovascular / biomechanical signature.
  runningMedianPaceSecPerKm?: number | null;
  runningMedianPowerWatts?: number | null;
  sportMedianDistanceKm?: Partial<Record<NormalizedSport, number>>;
  sportP90DistanceKm?: Partial<Record<NormalizedSport, number>>;
  sportMedianDurationMin?: Partial<Record<NormalizedSport, number>>;
  sportP90DurationMin?: Partial<Record<NormalizedSport, number>>;
  sportMedianTrainingLoad?: Partial<Record<NormalizedSport, number>>;
}

// Substring patterns hinting that Garmin labelled the activity "no training
// effect" (used to detect type/benefit mismatches like "logged a ride but
// the watch saw no training response").
const NO_TRAINING_EFFECT_PATTERNS = [
  'no training effect',
  'no benefit',
  '无训练效果',
  '无效益',
];

function lower(s: string | null | undefined): string {
  return (s ?? '').toLowerCase();
}

export function classifyActivityQuality(
  activity: NormalizedActivity,
  historicalContext?: QualityContext,
): QualityResult {
  const flags: QualityFlag[] = [];

  // ---- 0) physically implausible distance / duration ---------------------
  if (activity.durationMin > 0 && activity.distanceKm > 0) {
    const speedMps = (activity.distanceKm * 1000) / (activity.durationMin * 60);
    if (activity.sport === 'running' && speedMps > 8.5) {
      flags.push('implausible_distance_duration');
    }
    if (activity.sport === 'cycling' && speedMps > 25) {
      flags.push('implausible_distance_duration');
    }
  }

  // ---- 1) running: fast pace without matching HR / mechanics -------------
  if (activity.sport === 'running' && activity.averagePaceSecPerKm !== null) {
    const pace = activity.averagePaceSecPerKm;
    const hr = activity.averageHr;
    const personalMedian = historicalContext?.runningMedianPaceSecPerKm;
    const personalPower = historicalContext?.runningMedianPowerWatts;

    if (pace < 210 && (hr === null || hr < 130) && activity.durationMin >= 10) {
      flags.push('running_fast_low_hr');
    }

    if (
      personalMedian != null &&
      personalMedian > 0 &&
      pace < personalMedian * 0.78 &&
      (hr === null || hr < 145) &&
      activity.durationMin >= 10
    ) {
      flags.push('running_far_above_baseline_low_hr');
    }

    if (
      personalMedian != null &&
      personalMedian > 0 &&
      personalPower != null &&
      personalPower > 0 &&
      activity.averagePower !== null &&
      pace < personalMedian * 0.85 &&
      activity.averagePower < personalPower * 0.75
    ) {
      flags.push('running_power_pace_mismatch');
    }

    // Running dynamics are optional, but when present they should not
    // contradict a very fast performance. High ground contact time / vertical
    // oscillation paired with unusually fast pace suggests bad GPS / treadmill
    // calibration or a non-representative activity.
    const gct = activity.groundContactTime;
    const vo = normalizeVerticalOscillationCm(activity.verticalOscillation);
    const verticalRatio = activity.verticalRatio;
    const economyLooksPoor =
      (gct !== null && gct > 330) ||
      (vo !== null && vo > 12.5) ||
      (verticalRatio !== null && verticalRatio > 11.5);
    if (
      economyLooksPoor &&
      personalMedian != null &&
      personalMedian > 0 &&
      pace < personalMedian * 0.88
    ) {
      flags.push('running_economy_mismatch');
    }
  }

  // ---- 2) cycling: implausibly high speed paired with very low HR ---------
  // The cofounder spec calls out this case explicitly: "骑行平均速度远高于
  // 用户历史水平，且心率很低" — typical false positive is the user forgot
  // to stop the watch on a train / car ride.
  if (activity.sport === 'cycling') {
    const speed = activity.averageSpeed;
    const hr = activity.averageHr;
    if (speed !== null && hr !== null && hr < 100) {
      const personalThreshold =
        historicalContext?.cyclingMedianSpeedMps != null &&
        historicalContext.cyclingMedianSpeedMps > 0
          ? historicalContext.cyclingMedianSpeedMps * 1.5
          : null;
      const absoluteThreshold = 12; // m/s ≈ 43 km/h
      const triggers =
        speed > absoluteThreshold ||
        (personalThreshold !== null && speed > personalThreshold);
      if (triggers) {
        flags.push('cycling_high_speed_low_hr');
      }
    }
  }

  // ---- 3) cycling: long ride but no/low training load --------------------
  if (
    activity.sport === 'cycling' &&
    activity.distanceKm > 50 &&
    (activity.trainingLoad === null || activity.trainingLoad < 30)
  ) {
    flags.push('long_distance_no_training_load');
  }

  // ---- 4) distance recorded but no physiological signal at all -----------
  // Pure GPS trace with no HR / power / cadence is almost always a transit
  // log or a forgotten timer. Discount it from fitness derivation.
  if (
    activity.distanceKm > 0 &&
    activity.averageHr === null &&
    activity.averagePower === null &&
    activity.averageCadence === null
  ) {
    flags.push('distance_without_physiology');
  }

  // ---- 5) no HR + no Garmin training metrics at all ----------------------
  // Soft flag: the activity might still be usable (e.g., a treadmill run
  // logged manually) but we can't trust it for HR-zone derivation.
  if (
    activity.averageHr === null &&
    activity.trainingLoad === null &&
    activity.aerobicTrainingEffect === null &&
    activity.primaryBenefit === null
  ) {
    if (!flags.includes('distance_without_physiology')) {
      flags.push('no_heart_rate');
    }
  }

  // ---- 6) type / benefit mismatch ----------------------------------------
  // Garmin saying "no training effect" while the user logged it as cycling /
  // running suggests the device didn't actually see meaningful effort.
  const benefitText = `${lower(activity.primaryBenefit)} ${lower(
    activity.trainingEffectLabel,
  )}`.trim();
  if (
    benefitText.length > 0 &&
    NO_TRAINING_EFFECT_PATTERNS.some((p) => benefitText.includes(p))
  ) {
    flags.push('type_benefit_mismatch');
  }

  // ---- 7) speed inconsistent with HR (cycling broad case) ----------------
  // Looser version of (1): cycling with elevated speed but resting-level HR
  // even when below the absolute threshold — only triggers when Garmin
  // didn't already give us a load.
  if (
    activity.sport === 'cycling' &&
    !flags.includes('cycling_high_speed_low_hr') &&
    activity.averageSpeed !== null &&
    activity.averageSpeed > 8 && // ~28.8 km/h, generally requires effort
    activity.averageHr !== null &&
    activity.averageHr < 90 &&
    activity.trainingLoad === null
  ) {
    flags.push('speed_inconsistent_with_hr');
  }

  // ---- 8) too small to be a meaningful training record -------------------
  // Calendar should not show accidental starts, parking-lot spins, watch
  // tests, or tiny commutes as training sessions. Keep genuinely intense
  // short work if Garmin recorded enough load/effect, otherwise hide it.
  if (isEnduranceSport(activity.sport)) {
    const min = minimumTrainingSignal(activity.sport);
    const load = activity.trainingLoad ?? 0;
    const aerobic = activity.aerobicTrainingEffect ?? 0;
    const anaerobic = activity.anaerobicTrainingEffect ?? 0;
    const hasMeaningfulLoad = load >= min.trainingLoad ||
      aerobic >= min.trainingEffect ||
      anaerobic >= min.anaerobicEffect;
    const tooShort =
      activity.distanceKm < min.distanceKm ||
      activity.durationMin < min.durationMin;
    if (tooShort && !hasMeaningfulLoad) {
      flags.push('below_training_signal_threshold');
    }
  }

  // ---- 9) distance far outside personal capacity without matching load ----
  if (isEnduranceSport(activity.sport) && activity.distanceKm > 0) {
    const medianDistance = historicalContext?.sportMedianDistanceKm?.[activity.sport] ?? null;
    const p90Distance = historicalContext?.sportP90DistanceKm?.[activity.sport] ?? null;
    const medianDuration = historicalContext?.sportMedianDurationMin?.[activity.sport] ?? null;
    const p90Duration = historicalContext?.sportP90DurationMin?.[activity.sport] ?? null;
    const upperDistance = personalDistanceUpper(activity.sport, medianDistance, p90Distance);
    const upperDuration = personalDurationUpper(activity.sport, medianDuration, p90Duration);
    const farBeyondDistance = upperDistance !== null && activity.distanceKm > upperDistance;
    const farBeyondDuration = upperDuration !== null && activity.durationMin > upperDuration;
    if (farBeyondDistance || farBeyondDuration) {
      const expectedLoad = minimumLongActivityLoad(activity.sport, activity.distanceKm, activity.durationMin);
      const load = activity.trainingLoad;
      const hasStrongPhysiology =
        (load !== null && load >= expectedLoad) ||
        (activity.aerobicTrainingEffect !== null && activity.aerobicTrainingEffect >= 3) ||
        (activity.averageHr !== null && activity.averageHr >= 115) ||
        (activity.averagePower !== null && activity.averagePower > 0);
      if (!hasStrongPhysiology) {
        flags.push('above_personal_capacity');
      }
    }
  }

  // ---- 10) absolute extreme distance but Garmin saw almost no load --------
  if (isEnduranceSport(activity.sport) && activity.distanceKm > absoluteExtremeDistance(activity.sport)) {
    const load = activity.trainingLoad;
    const effect = Math.max(
      activity.aerobicTrainingEffect ?? 0,
      activity.anaerobicTrainingEffect ?? 0,
    );
    if ((load === null || load < minimumLongActivityLoad(activity.sport, activity.distanceKm, activity.durationMin)) && effect < 2) {
      flags.push('extreme_distance_low_load');
    }
  }

  return { confidence: deriveConfidence(flags), flags };
}

function deriveConfidence(flags: QualityFlag[]): Confidence {
  const hard = new Set<QualityFlag>([
    'cycling_high_speed_low_hr',
    'running_fast_low_hr',
    'running_far_above_baseline_low_hr',
    'distance_without_physiology',
    'long_distance_no_training_load',
    'implausible_distance_duration',
    'below_training_signal_threshold',
    'above_personal_capacity',
    'extreme_distance_low_load',
  ]);
  if (flags.some((f) => hard.has(f))) return 'low';
  const soft = new Set<QualityFlag>([
    'no_heart_rate',
    'running_power_pace_mismatch',
    'running_economy_mismatch',
    'speed_inconsistent_with_hr',
    'type_benefit_mismatch',
  ]);
  if (flags.some((f) => soft.has(f))) return 'medium';
  return 'high';
}

function isEnduranceSport(sport: NormalizedSport): sport is 'running' | 'cycling' | 'swimming' {
  return sport === 'running' || sport === 'cycling' || sport === 'swimming';
}

function minimumTrainingSignal(
  sport: 'running' | 'cycling' | 'swimming',
): { distanceKm: number; durationMin: number; trainingLoad: number; trainingEffect: number; anaerobicEffect: number } {
  if (sport === 'running') {
    return { distanceKm: 1, durationMin: 8, trainingLoad: 10, trainingEffect: 1, anaerobicEffect: 0.7 };
  }
  if (sport === 'cycling') {
    return { distanceKm: 3, durationMin: 10, trainingLoad: 10, trainingEffect: 1, anaerobicEffect: 0.7 };
  }
  return { distanceKm: 0.2, durationMin: 8, trainingLoad: 8, trainingEffect: 0.8, anaerobicEffect: 0.6 };
}

function personalDistanceUpper(
  sport: 'running' | 'cycling' | 'swimming',
  medianDistance: number | null,
  p90Distance: number | null,
): number | null {
  const absolute = sport === 'running' ? 70 : sport === 'cycling' ? 220 : 10;
  const candidates = [absolute];
  if (medianDistance !== null && medianDistance > 0) {
    candidates.push(medianDistance * (sport === 'cycling' ? 4 : 3.5));
  }
  if (p90Distance !== null && p90Distance > 0) {
    candidates.push(p90Distance * (sport === 'cycling' ? 2.2 : 2));
  }
  return Math.max(...candidates);
}

function personalDurationUpper(
  sport: 'running' | 'cycling' | 'swimming',
  medianDuration: number | null,
  p90Duration: number | null,
): number | null {
  const absolute = sport === 'running' ? 300 : sport === 'cycling' ? 720 : 240;
  const candidates = [absolute];
  if (medianDuration !== null && medianDuration > 0) {
    candidates.push(medianDuration * (sport === 'cycling' ? 4 : 3.5));
  }
  if (p90Duration !== null && p90Duration > 0) {
    candidates.push(p90Duration * (sport === 'cycling' ? 2.2 : 2));
  }
  return Math.max(...candidates);
}

function minimumLongActivityLoad(
  sport: 'running' | 'cycling' | 'swimming',
  distanceKm: number,
  durationMin: number,
): number {
  if (sport === 'cycling') {
    return Math.max(60, Math.min(300, distanceKm * 0.9, durationMin * 0.45));
  }
  if (sport === 'running') {
    return Math.max(45, Math.min(220, distanceKm * 4, durationMin * 0.6));
  }
  return Math.max(25, Math.min(160, distanceKm * 20, durationMin * 0.5));
}

function absoluteExtremeDistance(sport: 'running' | 'cycling' | 'swimming'): number {
  if (sport === 'cycling') return 250;
  if (sport === 'running') return 80;
  return 12;
}

function normalizeVerticalOscillationCm(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  // Garmin endpoints may expose vertical oscillation in mm or cm. Treat
  // values above 30 as millimeters and normalize to centimeters.
  return value > 30 ? value / 10 : value;
}
