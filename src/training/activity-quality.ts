// classifyActivityQuality — pure detector for unreliable activities.
//
// Translated from cofounder spec "活动可信度判断" (training-plan-generation
// -refactor.md, lines ~220-247). Output is consumed by athlete-profile and
// recent-state derivation to filter low-quality data points.
//
// No I/O, no LLM, no DB.

import type { NormalizedActivity } from './activity-normalizer.js';

export type Confidence = 'high' | 'medium' | 'low';

export type QualityFlag =
  | 'no_heart_rate'
  | 'cycling_high_speed_low_hr'
  | 'distance_without_physiology'
  | 'long_distance_no_training_load'
  | 'speed_inconsistent_with_hr'
  | 'type_benefit_mismatch';

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

  // ---- 1) cycling: implausibly high speed paired with very low HR ---------
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

  // ---- 2) cycling: long ride but no/low training load --------------------
  if (
    activity.sport === 'cycling' &&
    activity.distanceKm > 50 &&
    (activity.trainingLoad === null || activity.trainingLoad < 30)
  ) {
    flags.push('long_distance_no_training_load');
  }

  // ---- 3) distance recorded but no physiological signal at all -----------
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

  // ---- 4) no HR + no Garmin training metrics at all ----------------------
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

  // ---- 5) type / benefit mismatch ----------------------------------------
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

  // ---- 6) speed inconsistent with HR (cycling broad case) ----------------
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

  return { confidence: deriveConfidence(flags), flags };
}

function deriveConfidence(flags: QualityFlag[]): Confidence {
  const hard = new Set<QualityFlag>([
    'cycling_high_speed_low_hr',
    'distance_without_physiology',
    'long_distance_no_training_load',
  ]);
  if (flags.some((f) => hard.has(f))) return 'low';
  const soft = new Set<QualityFlag>([
    'no_heart_rate',
    'speed_inconsistent_with_hr',
    'type_benefit_mismatch',
  ]);
  if (flags.some((f) => soft.has(f))) return 'medium';
  return 'high';
}
