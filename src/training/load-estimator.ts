import type { ParameterizedWorkout } from './parameterizer.js';
import type { NormalizedActivity } from './activity-normalizer.js';
import type { QualityResult } from './activity-quality.js';

export type TrainingLoadTag =
  | 'recovery'
  | 'easy'
  | 'long'
  | 'tempo'
  | 'threshold'
  | 'vo2'
  | 'anaerobic';

const TRAINING_LOAD_TAGS: readonly TrainingLoadTag[] = [
  'recovery',
  'easy',
  'long',
  'tempo',
  'threshold',
  'vo2',
  'anaerobic',
];

export interface WorkoutLoadEstimate {
  trainingLoad: number;
  tag: TrainingLoadTag;
  minutes: number;
  easyMinutes: number;
  recoveryMinutes: number;
  hardMinutes: number;
  veryHardMinutes: number;
  loadPerMinute: number;
}

export interface WeeklyLoadEstimate {
  trainingLoad: number;
  workouts: WorkoutLoadEstimate[];
}

export interface TrainingLoadCalibrationEntry {
  samples: number;
  medianLoad: number;
  medianMinutes: number;
  medianLoadPerMinute: number;
  source: 'direct' | 'sport_low' | 'sport_high' | 'sport_all';
}

export type TrainingLoadCalibration = Partial<
  Record<string, Partial<Record<TrainingLoadTag, TrainingLoadCalibrationEntry>>>
>;

const SPORT_FACTOR: Record<string, number> = {
  running: 1.95,
  cycling: 1.55,
  swimming: 1.2,
};

const SPORT_TAG_FACTOR: Partial<Record<string, Partial<Record<TrainingLoadTag, number>>>> = {
  running: {
    // Garmin load calibration from recent activity samples:
    // low-intensity running clusters around 1.1-1.6 load/min, while structured
    // threshold sessions with recoveries should sit below continuous threshold
    // race-effort proxies of similar total duration.
    recovery: 1.5,
    easy: 1.6,
    long: 1.45,
    threshold: 1.65,
  },
  cycling: {
    recovery: 1.0,
    easy: 1.05,
    long: 0.95,
  },
};

const TAG_COEFFICIENT: Record<TrainingLoadTag, number> = {
  recovery: 0.82,
  easy: 1.0,
  long: 1.12,
  tempo: 1.55,
  threshold: 1.95,
  vo2: 2.45,
  anaerobic: 2.75,
};

const TAG_STIMULI: Record<TrainingLoadTag, readonly string[]> = {
  recovery: ['recovery'],
  easy: ['aerobic'],
  long: ['long_endurance', 'aerobic'],
  tempo: ['tempo'],
  threshold: ['threshold'],
  vo2: ['vo2max'],
  anaerobic: ['anaerobic', 'sprint'],
};

export function estimateWeeklyTrainingLoad(
  workouts: readonly ParameterizedWorkout[],
  calibration?: TrainingLoadCalibration,
): WeeklyLoadEstimate {
  const estimates = workouts.map((workout) =>
    estimateWorkoutTrainingLoad(workout, calibration),
  );
  return {
    trainingLoad: roundLoad(estimates.reduce((sum, e) => sum + e.trainingLoad, 0)),
    workouts: estimates,
  };
}

export function estimateWorkoutTrainingLoad(
  workout: ParameterizedWorkout,
  calibration?: TrainingLoadCalibration,
): WorkoutLoadEstimate {
  const minutes = positiveNumber(workout.durationMinutes);
  if (minutes <= 0 || workout.sport === 'rest' || workout.sport === 'mobility') {
    return {
      trainingLoad: 0,
      tag: 'recovery',
      minutes: 0,
      easyMinutes: 0,
      recoveryMinutes: 0,
      hardMinutes: 0,
      veryHardMinutes: 0,
      loadPerMinute: 0,
    };
  }

  const tag = classifyWorkoutLoadTag(workout);
  const structure = inferStructureMinutes(workout, tag, minutes);
  const sportFactor = SPORT_TAG_FACTOR[workout.sport]?.[tag] ?? SPORT_FACTOR[workout.sport] ?? 1.5;
  const hardCoeff = TAG_COEFFICIENT[tag] ?? 1.4;
  const raw =
    structure.easyMinutes * 1.0 +
    structure.recoveryMinutes * 0.75 +
    structure.hardMinutes * hardCoeff +
    structure.veryHardMinutes * 3.2;
  const continuity =
    tag === 'long' ? 1.18 :
    tag === 'threshold' ? 1.08 :
    tag === 'vo2' ? 1.03 :
    1;
  const baseLoad = raw * sportFactor * continuity;
  const trainingLoad = roundLoad(
    applyTrainingLoadCalibration(baseLoad, workout.sport, tag, minutes, calibration),
  );
  return {
    trainingLoad,
    tag,
    minutes,
    ...structure,
    loadPerMinute: minutes > 0 ? trainingLoad / minutes : 0,
  };
}

export function buildTrainingLoadCalibration(
  activities: readonly NormalizedActivity[],
  qualities?: ReadonlyMap<string, QualityResult>,
): TrainingLoadCalibration {
  const rows = activities
    .filter((activity) => {
      if (
        !activity.sport ||
        (activity.sport !== 'running' && activity.sport !== 'cycling' && activity.sport !== 'swimming')
      ) {
        return false;
      }
      if (!Number.isFinite(activity.durationMin) || activity.durationMin < 10) return false;
      if (activity.trainingLoad === null || !Number.isFinite(activity.trainingLoad) || activity.trainingLoad < 50) return false;
      const quality = qualities?.get(activity.id);
      return quality?.confidence !== 'low';
    })
    .map((activity) => ({
      sport: activity.sport,
      stimulus: normalizeStimulus(activity),
      minutes: activity.durationMin,
      load: activity.trainingLoad as number,
    }));

  const out: TrainingLoadCalibration = {};
  for (const sport of ['running', 'cycling', 'swimming'] as const) {
    const sportRows = rows.filter((row) => row.sport === sport);
    if (sportRows.length === 0) continue;
    out[sport] = {};
    for (const tag of TRAINING_LOAD_TAGS) {
      const direct = sportRows.filter((row) => stimulusMatchesTag(row, tag));
      const low = sportRows.filter((row) => isLowStimulus(row.stimulus));
      const high = sportRows.filter((row) => isHighStimulus(row.stimulus));
      const pool =
        direct.length >= 2
          ? direct
          : isLowTag(tag) && low.length >= 2
            ? low
            : isHighTag(tag) && high.length >= 2
              ? high
              : sportRows.length >= 2
                ? sportRows
                : direct;
      if (pool.length < 2) continue;
      const source: TrainingLoadCalibrationEntry['source'] =
        pool === direct ? 'direct' :
        pool === low ? 'sport_low' :
        pool === high ? 'sport_high' :
        'sport_all';
      const loads = pool.map((row) => row.load);
      const minutes = pool.map((row) => row.minutes);
      const lpms = pool.map((row) => row.load / row.minutes).filter(Number.isFinite);
      const medianLoad = median(loads);
      const medianMinutes = median(minutes);
      const medianLoadPerMinute = median(lpms);
      if (medianLoad === null || medianMinutes === null || medianLoadPerMinute === null) continue;
      out[sport][tag] = {
        samples: pool.length,
        medianLoad: roundTo(medianLoad, 1),
        medianMinutes: roundTo(medianMinutes, 1),
        medianLoadPerMinute: roundTo(medianLoadPerMinute, 3),
        source,
      };
    }
  }
  return out;
}

export function classifyWorkoutLoadTag(workout: ParameterizedWorkout): TrainingLoadTag {
  const key = `${workout.templateId} ${workout.workoutType} ${workout.title}`.toLowerCase();
  if (key.includes('recovery') || key.includes('mobility') || key.includes('walk') || key.includes('恢复')) {
    return 'recovery';
  }
  if (key.includes('long') || key.includes('lsd') || key.includes('endurance') || key.includes('长距离')) {
    return 'long';
  }
  if (key.includes('anaerobic') || key.includes('sprint') || key.includes('hill') || key.includes('无氧') || key.includes('短冲') || key.includes('坡')) {
    return 'anaerobic';
  }
  if (key.includes('vo2') || key.includes('interval') || key.includes('pyramid') || key.includes('间歇') || key.includes('金字塔')) {
    return 'vo2';
  }
  if (key.includes('threshold') || key.includes('css') || key.includes('over_under') || key.includes('阈值')) {
    return 'threshold';
  }
  if (key.includes('tempo') || key.includes('sweet_spot') || key.includes('race_pace') || key.includes('progression') || key.includes('节奏') || key.includes('甜区') || key.includes('比赛配速') || key.includes('递进')) {
    return 'tempo';
  }
  if (workout.intensity === 'low') return 'easy';
  if (workout.intensity === 'medium') return 'tempo';
  return 'threshold';
}

function applyTrainingLoadCalibration(
  baseLoad: number,
  sport: string,
  tag: TrainingLoadTag,
  minutes: number,
  calibration?: TrainingLoadCalibration,
): number {
  const entry = calibration?.[sport]?.[tag];
  if (!entry || entry.samples < 2 || entry.medianLoad <= 0 || entry.medianMinutes <= 0) {
    return baseLoad;
  }

  const target = isLowTag(tag)
    ? entry.medianLoadPerMinute * minutes
    : highIntensityCalibrationTarget(entry, minutes);
  if (!Number.isFinite(target) || target <= 0) return baseLoad;

  const direct = entry.source === 'direct';
  const sampleWeight = isLowTag(tag)
    ? Math.min(1, 0.55 + entry.samples / 12)
    : Math.min(1, Math.max(0, entry.samples / 6));
  const weight = isLowTag(tag)
    ? (direct ? 0.72 : 0.5) * sampleWeight
    : (direct ? 0.36 : 0.26) * sampleWeight;
  const blended = baseLoad * (1 - weight) + target * weight;
  const minFactor = isLowTag(tag) ? 0.55 : 0.75;
  const maxFactor = isLowTag(tag) ? 1.8 : 1.35;
  return clamp(blended, baseLoad * minFactor, baseLoad * maxFactor);
}

function highIntensityCalibrationTarget(
  entry: TrainingLoadCalibrationEntry,
  minutes: number,
): number {
  const ratio = minutes / entry.medianMinutes;
  if (!Number.isFinite(ratio) || ratio <= 0) return entry.medianLoad;
  // Garmin's load response for quality sessions is not linear in total
  // duration: warmup/cooldown and recoveries grow with the workout. Scale
  // recent hard-session load sub-linearly so short intense samples do not
  // explode longer planned threshold/VO2 sessions.
  return entry.medianLoad * Math.sqrt(ratio);
}

function normalizeStimulus(activity: NormalizedActivity): string {
  const label = `${activity.trainingEffectLabel ?? ''} ${activity.primaryBenefit ?? ''}`.toLowerCase();
  if (label.includes('recovery')) return 'recovery';
  if (label.includes('long')) return 'long_endurance';
  if (label.includes('anaerobic')) return 'anaerobic';
  if (label.includes('sprint')) return 'sprint';
  if (label.includes('vo2')) return 'vo2max';
  if (label.includes('threshold') || label.includes('lactate')) return 'threshold';
  if (label.includes('tempo')) return 'tempo';
  if (label.includes('aerobic') || label.includes('base')) return 'aerobic';
  const aer = activity.aerobicTrainingEffect ?? 0;
  const ana = activity.anaerobicTrainingEffect ?? 0;
  if (ana >= 2.5) return 'anaerobic';
  if (aer >= 4.2) return 'vo2max';
  if (aer >= 3.5) return 'threshold';
  if (aer >= 3.0) return 'tempo';
  if (aer > 0 && aer < 2.2) return 'recovery';
  return 'aerobic';
}

function stimulusMatchesTag(
  row: { stimulus: string; minutes: number },
  tag: TrainingLoadTag,
): boolean {
  if (tag === 'long') {
    return (
      row.stimulus === 'long_endurance' ||
      (row.stimulus === 'aerobic' && row.minutes >= 75)
    );
  }
  return TAG_STIMULI[tag].includes(row.stimulus);
}

function isLowTag(tag: TrainingLoadTag): boolean {
  return tag === 'recovery' || tag === 'easy' || tag === 'long';
}

function isHighTag(tag: TrainingLoadTag): boolean {
  return !isLowTag(tag);
}

function isLowStimulus(stimulus: string): boolean {
  return stimulus === 'recovery' || stimulus === 'aerobic' || stimulus === 'long_endurance';
}

function isHighStimulus(stimulus: string): boolean {
  return stimulus === 'tempo' || stimulus === 'threshold' || stimulus === 'vo2max' || stimulus === 'anaerobic' || stimulus === 'sprint';
}

function inferStructureMinutes(
  workout: ParameterizedWorkout,
  tag: TrainingLoadTag,
  minutes: number,
): Pick<WorkoutLoadEstimate, 'easyMinutes' | 'recoveryMinutes' | 'hardMinutes' | 'veryHardMinutes'> {
  const vars = workout.parameterSource?.replacedVariables ?? {};
  const explicit = explicitIntervalMinutes(vars, tag, minutes);
  if (explicit) return explicit;

  const mainDuration = numberFromVars(vars, ['mainDurationTotal', 'mainDuration']);
  let hardMinutes = 0;
  let veryHardMinutes = 0;
  let recoveryMinutes = 0;

  if (mainDuration > 0) {
    if (tag === 'recovery') {
      recoveryMinutes = minutes * 0.75;
    } else {
      if (tag === 'tempo') hardMinutes = mainDuration * 0.62;
      else if (tag === 'threshold') hardMinutes = mainDuration * 0.72;
      else if (tag === 'vo2') {
        hardMinutes = mainDuration * 0.48;
        veryHardMinutes = mainDuration * 0.15;
      } else if (tag === 'anaerobic') {
        hardMinutes = mainDuration * 0.25;
        veryHardMinutes = mainDuration * 0.35;
      } else if (tag === 'long') {
        hardMinutes = mainDuration * 0.08;
      }
      recoveryMinutes = Math.max(0, mainDuration - hardMinutes - veryHardMinutes) * recoveryShare(tag);
    }
  } else if (tag === 'tempo') {
    hardMinutes = minutes * 0.42;
  } else if (tag === 'threshold') {
    hardMinutes = minutes * 0.44;
  } else if (tag === 'vo2') {
    hardMinutes = minutes * 0.25;
    veryHardMinutes = minutes * 0.08;
  } else if (tag === 'anaerobic') {
    hardMinutes = minutes * 0.15;
    veryHardMinutes = minutes * 0.18;
  } else if (tag === 'recovery') {
    recoveryMinutes = minutes * 0.65;
  }

  hardMinutes = clamp(hardMinutes, 0, minutes);
  veryHardMinutes = clamp(veryHardMinutes, 0, Math.max(0, minutes - hardMinutes));
  recoveryMinutes = clamp(recoveryMinutes, 0, Math.max(0, minutes - hardMinutes - veryHardMinutes));
  return {
    easyMinutes: Math.max(0, minutes - hardMinutes - veryHardMinutes - recoveryMinutes),
    recoveryMinutes,
    hardMinutes,
    veryHardMinutes,
  };
}

function explicitIntervalMinutes(
  vars: Record<string, string | number>,
  tag: TrainingLoadTag,
  minutes: number,
): Pick<WorkoutLoadEstimate, 'easyMinutes' | 'recoveryMinutes' | 'hardMinutes' | 'veryHardMinutes'> | null {
  const repeatKeys = [
    'thresholdRepeats',
    'tempoRepeats',
    'vo2Repeats',
    'intervalRepeats',
    'cssRepeats',
    'sweetSpotRepeats',
    'anaerobicRepeats',
    'sprintRepeats',
    'hillRepeats',
    'mainRepeats',
    'continuousBlocks',
  ];
  const durationKeys = [
    'thresholdDuration',
    'tempoDuration',
    'vo2Duration',
    'intervalDuration',
    'cssDuration',
    'sweetSpotDuration',
    'anaerobicDuration',
    'sprintDuration',
    'hillDuration',
    'blockDuration',
    'mainDuration',
  ];
  const reps = numberFromVars(vars, repeatKeys);
  let workDuration = numberFromVars(vars, durationKeys);
  const workSeconds = numberFromVars(vars, ['strideDuration', 'hillDurationSeconds', 'sprintDurationSeconds']);
  if (workDuration <= 0 && workSeconds > 0) workDuration = workSeconds / 60;
  if (reps <= 0 || workDuration <= 0) return null;

  const workMinutes = clamp(reps * workDuration, 0, minutes);
  const recoveryDuration = numberFromVars(vars, ['recoveryDuration', 'strideRecovery']);
  const recoverySeconds = numberFromVars(vars, ['restSeconds', 'sprintRestSeconds', 'drillRest']);
  const perRecovery = recoveryDuration > 0 ? recoveryDuration : recoverySeconds / 60;
  const recoveryMinutes = clamp(Math.max(0, reps - 1) * Math.max(0, perRecovery), 0, Math.max(0, minutes - workMinutes));
  const veryHardShare = tag === 'anaerobic' ? 0.62 : tag === 'vo2' ? 0.25 : 0;
  const veryHardMinutes = workMinutes * veryHardShare;
  const hardMinutes = workMinutes - veryHardMinutes;
  return {
    easyMinutes: Math.max(0, minutes - hardMinutes - veryHardMinutes - recoveryMinutes),
    recoveryMinutes,
    hardMinutes,
    veryHardMinutes,
  };
}

function recoveryShare(tag: TrainingLoadTag): number {
  if (tag === 'vo2' || tag === 'anaerobic') return 0.55;
  if (tag === 'threshold' || tag === 'tempo') return 0.38;
  return 0.25;
}

function numberFromVars(vars: Record<string, string | number>, keys: readonly string[]): number {
  for (const key of keys) {
    const value = vars[key];
    const n = positiveNumber(value);
    if (n > 0) return n;
  }
  return 0;
}

function positiveNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function median(values: readonly number[]): number | null {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .slice()
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function roundLoad(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value);
}
