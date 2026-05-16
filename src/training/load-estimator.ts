import type { ParameterizedWorkout } from './parameterizer.js';

export type TrainingLoadTag =
  | 'recovery'
  | 'easy'
  | 'long'
  | 'tempo'
  | 'threshold'
  | 'vo2'
  | 'anaerobic';

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

const SPORT_FACTOR: Record<string, number> = {
  running: 1.95,
  cycling: 1.55,
  swimming: 1.2,
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

export function estimateWeeklyTrainingLoad(
  workouts: readonly ParameterizedWorkout[],
): WeeklyLoadEstimate {
  const estimates = workouts.map(estimateWorkoutTrainingLoad);
  return {
    trainingLoad: roundLoad(estimates.reduce((sum, e) => sum + e.trainingLoad, 0)),
    workouts: estimates,
  };
}

export function estimateWorkoutTrainingLoad(workout: ParameterizedWorkout): WorkoutLoadEstimate {
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
  const sportFactor = SPORT_FACTOR[workout.sport] ?? 1.5;
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
  const trainingLoad = roundLoad(raw * sportFactor * continuity);
  return {
    trainingLoad,
    tag,
    minutes,
    ...structure,
    loadPerMinute: minutes > 0 ? trainingLoad / minutes : 0,
  };
}

export function classifyWorkoutLoadTag(workout: ParameterizedWorkout): TrainingLoadTag {
  const key = `${workout.templateId} ${workout.workoutType} ${workout.title}`.toLowerCase();
  if (key.includes('recovery') || key.includes('mobility') || key.includes('walk')) {
    return 'recovery';
  }
  if (key.includes('long') || key.includes('lsd') || key.includes('endurance')) {
    return 'long';
  }
  if (key.includes('anaerobic') || key.includes('sprint') || key.includes('hill')) {
    return 'anaerobic';
  }
  if (key.includes('vo2') || key.includes('interval') || key.includes('pyramid')) {
    return 'vo2';
  }
  if (key.includes('threshold') || key.includes('css') || key.includes('over_under')) {
    return 'threshold';
  }
  if (key.includes('tempo') || key.includes('sweet_spot') || key.includes('race_pace') || key.includes('progression')) {
    return 'tempo';
  }
  if (workout.intensity === 'low') return 'easy';
  if (workout.intensity === 'medium') return 'tempo';
  return 'threshold';
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

function roundLoad(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value);
}
