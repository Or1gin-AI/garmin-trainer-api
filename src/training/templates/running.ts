// Running templates (U5).
//
// Translated verbatim from the cofounder spec
// "training-plan-generation-refactor.md → 跑步模板".
//
// Notes on interpretation:
//   - Phase durations use `$varName` placeholders that the parameterizer
//     resolves from `variables`. Numeric defaults come from the spec's
//     "默认时长" / structure descriptions.
//   - Where the spec gives a range (e.g. "70-110 分钟") we expose that as
//     min/max on the relevant variable.
//   - HR / pace targets reference logical names (HR.aerobic, RUN.easyPace, ...)
//     declared in variables.ts. The parameterizer formats the resolved
//     numeric values into display strings like "132-146 bpm" or "5:00-5:10/km".
//   - "组间慢跑" recovery durations are encoded as `recoveryDuration` per
//     the project-wide naming convention.

import type { WorkoutTemplate } from './types.js';

const PROGRESSION_LOW: WorkoutTemplate['progression'] = {
  conservative: { durationMultiplier: 0.85, repeatDelta: 0 },
  normal: { durationMultiplier: 1.0, repeatDelta: 0 },
  aggressive: { durationMultiplier: 1.1, repeatDelta: 0 },
};

const PROGRESSION_INTERVAL: WorkoutTemplate['progression'] = {
  conservative: { durationMultiplier: 0.8, repeatDelta: -2 },
  normal: { durationMultiplier: 1.0, repeatDelta: 0 },
  aggressive: { durationMultiplier: 1.1, repeatDelta: 1 },
};

const PROGRESSION_AEROBIC: WorkoutTemplate['progression'] = {
  conservative: { durationMultiplier: 0.8, repeatDelta: 0 },
  normal: { durationMultiplier: 1.0, repeatDelta: 0 },
  aggressive: { durationMultiplier: 1.15, repeatDelta: 0 },
};

// ---------------------------------------------------------------------------
// run.recovery.v1 — 恢复跑
// 默认时长 30-45 分钟，热身 5 / 主训练 20-35 / 放松 5。
// 目标心率 HR.recovery，配速不适用。
// ---------------------------------------------------------------------------
const runRecovery: WorkoutTemplate = {
  id: 'run.recovery.v1',
  fixed: {
    sport: 'running',
    workoutType: 'recovery',
    title: 'Recovery Run',
    purpose: 'Promote recovery without adding new training stress.',
    intensity: 'low',
    stress: 'low',
    primaryMetric: 'heart_rate',
    allowedMetrics: ['heart_rate'],
    phases: [
      { name: 'warmup', label: 'Warm-up', duration: '$warmupDuration', description: 'Bring heart rate up into HR.recovery.' },
      { name: 'main', label: 'Main set', duration: '$mainDuration', description: 'Hold heart rate in HR.recovery, RPE 2-3/10.' },
      { name: 'cooldown', label: 'Cool-down', duration: '$cooldownDuration', description: 'Keep heart rate below HR.recovery.high.' },
    ],
    contraindications: [],
    downgradeTo: 'rest.walk.v1',
    requiredRecoveryHoursAfter: 0,
    minDurationMinutes: 30,
    maxDurationMinutes: 45,
    notes: 'If fatigue is high_risk, switch to a 20-30 min brisk walk or full rest.',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 5, unit: 'minutes' } },
    mainDuration: { source: { kind: 'template_default', default: 25, unit: 'minutes' } },
    cooldownDuration: { source: { kind: 'template_default', default: 5, unit: 'minutes' } },
    targetHeartRate: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.recoveryRange', unit: 'bpm' } },
    targetPaceCap: {
      source: { kind: 'derived', from: 'athleteProfile.running.easyPaceSecPerKm', rule: '+20 s/km (upper cap, optional)', optional: true, unit: 's/km' },
      description: 'If the athlete relies on pace, write "slower than RUN.easyPace by 20 s/km". Otherwise targetPace = N/A.',
    },
  },
  progression: PROGRESSION_LOW,
};

// ---------------------------------------------------------------------------
// run.aerobic.v1 — 普通有氧跑
// 默认时长 40-65 分钟，热身 10 / 主训练 25-45 / 放松 5-10。
// ---------------------------------------------------------------------------
const runAerobic: WorkoutTemplate = {
  id: 'run.aerobic.v1',
  fixed: {
    sport: 'running',
    workoutType: 'aerobic',
    title: 'Aerobic Run',
    purpose: 'Maintain the aerobic base; the foundation session of the weekly plan.',
    intensity: 'low',
    stress: 'medium',
    primaryMetric: 'heart_rate',
    allowedMetrics: ['heart_rate', 'pace'],
    phases: [
      { name: 'warmup', label: 'Warm-up', duration: '$warmupDuration', description: 'HR.recovery building to HR.zone2.' },
      { name: 'main', label: 'Main set', duration: '$mainDuration', description: 'Hold HR.zone2.' },
      { name: 'cooldown', label: 'Cool-down', duration: '$cooldownDuration', description: 'Let heart rate settle back to HR.recovery.' },
    ],
    contraindications: ['fatigue.high_risk'],
    downgradeTo: 'run.recovery.v1',
    requiredRecoveryHoursAfter: 0,
    minDurationMinutes: 40,
    maxDurationMinutes: 65,
    notes: 'Driven by Garmin Zone 2 / HR.aerobic, no pace cap. If the latest reliable activity was vo2max/anaerobic and fatigue is elevated, keep it at 45 min or less; if 7-day load is ramping quickly, shorten the main set by 20%.',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 10, unit: 'minutes' } },
    mainDuration: {
      source: { kind: 'athlete_profile', path: 'athleteProfile.running.aerobicMainDurationMinutes', min: 25, max: 45, unit: 'minutes' },
    },
    cooldownDuration: { source: { kind: 'template_default', default: 8, unit: 'minutes' } },
    targetHeartRate: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.zone2Range', unit: 'bpm' } },
    metricMode: {
      source: { kind: 'template_default', default: 'auto' },
      description: 'auto = heart rate first, may switch to pace when pace is stable; decided by the parameterizer.',
    },
  },
  progression: PROGRESSION_AEROBIC,
};

// ---------------------------------------------------------------------------
// run.lsd.v1 — LSD 长距离有氧跑
// 默认时长 70-110 分钟（初级 50-75）。
// ---------------------------------------------------------------------------
const runLsd: WorkoutTemplate = {
  id: 'run.lsd.v1',
  fixed: {
    sport: 'running',
    workoutType: 'lsd',
    title: 'Long Run (LSD)',
    purpose: 'Build aerobic base, fat metabolism and long-duration durability.',
    intensity: 'low',
    stress: 'high',
    primaryMetric: 'heart_rate',
    allowedMetrics: ['heart_rate'],
    phases: [
      { name: 'warmup', label: 'Warm-up', duration: '$warmupDuration', description: 'Gradually bring heart rate into HR.zone2.' },
      { name: 'main', label: 'Main set', duration: '$mainDuration', description: 'Hold HR.zone2 throughout; no surges.' },
      { name: 'cooldown', label: 'Cool-down', duration: '$cooldownDuration', description: 'Bring heart rate down to HR.recovery.' },
    ],
    contraindications: ['latestStimulus.threshold', 'latestStimulus.vo2max', 'latestStimulus.anaerobic', 'fatigue.high_risk'],
    downgradeTo: 'run.aerobic.v1',
    requiredRecoveryHoursAfter: 36,
    minDurationMinutes: 70,
    maxDurationMinutes: 110,
    notes: 'Beginners: 50-75 min. If recent training load is high, downgrade to run.aerobic.v1 for 45-60 min.',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 10, unit: 'minutes' } },
    mainDuration: {
      source: { kind: 'athlete_profile', path: 'athleteProfile.running.lsdMainDurationMinutes', min: 50, max: 90, unit: 'minutes' },
    },
    cooldownDuration: { source: { kind: 'template_default', default: 10, unit: 'minutes' } },
    targetHeartRate: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.zone2Range', unit: 'bpm' } },
    distanceKm: {
      source: { kind: 'derived', from: 'mainDuration + targetHeartRate', rule: 'LSD is heart-rate driven; do not back-calculate distance from pace', optional: true, unit: 'km' },
    },
  },
  progression: PROGRESSION_AEROBIC,
};

// ---------------------------------------------------------------------------
// run.tempo.v1 — 节奏跑
// 默认时长 50-70 分钟。
// 主训练 2 x 12 分钟 RUN.tempoPace，组间慢跑 4 分钟。
// ---------------------------------------------------------------------------
const runTempo: WorkoutTemplate = {
  id: 'run.tempo.v1',
  fixed: {
    sport: 'running',
    workoutType: 'tempo',
    title: 'Tempo Run',
    purpose: 'Build sustained cruising ability at moderate-high intensity, just below threshold.',
    intensity: 'medium',
    stress: 'medium',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: 'Warm-up', duration: '$warmupDuration', description: 'Finish with 4 x 20 s relaxed strides, 60 s jog between.' },
      { name: 'main', label: 'Main set', duration: '$mainDurationTotal', description: '$tempoRepeats x $tempoDuration min at RUN.tempoPace, $recoveryDuration min jog between reps.' },
      { name: 'cooldown', label: 'Cool-down', duration: '$cooldownDuration', description: 'Let heart rate settle back to HR.recovery.' },
    ],
    contraindications: ['latestStimulus.threshold', 'latestStimulus.vo2max', 'latestStimulus.anaerobic'],
    downgradeTo: 'run.aerobic.v1',
    requiredRecoveryHoursAfter: 48,
    minDurationMinutes: 50,
    maxDurationMinutes: 70,
    notes: 'Beginners: 3 x 6 min instead; if fatigue is elevated, switch to run.aerobic.v1.',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 15, unit: 'minutes' } },
    tempoRepeats: { source: { kind: 'template_default', default: 2, unit: 'reps' } },
    tempoDuration: { source: { kind: 'template_default', default: 12, unit: 'minutes' } },
    recoveryDuration: { source: { kind: 'template_default', default: 4, unit: 'minutes' } },
    cooldownDuration: { source: { kind: 'template_default', default: 13, unit: 'minutes' } },
    mainDurationTotal: {
      source: { kind: 'derived', from: 'tempoRepeats,tempoDuration,recoveryDuration', rule: 'tempoRepeats * tempoDuration + (tempoRepeats - 1) * recoveryDuration', unit: 'minutes' },
    },
    targetPace: { source: { kind: 'athlete_profile', path: 'athleteProfile.running.tempoPaceSecPerKm', unit: 's/km' } },
    targetHeartRate: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.tempoRange', unit: 'bpm' } },
    protectiveHrCap: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.thresholdRange', unit: 'bpm' }, description: 'Cap at HR.threshold.high.' },
  },
  progression: {
    conservative: { durationMultiplier: 0.85, repeatDelta: -1 },
    normal: { durationMultiplier: 1.0, repeatDelta: 0 },
    aggressive: { durationMultiplier: 1.1, repeatDelta: 1 },
  },
};

// ---------------------------------------------------------------------------
// run.threshold.v1 — 阈值跑
// 默认时长 55-75 分钟。3 x 8 分钟 HR.threshold / Zone 4，组间慢跑 3 分钟。
// ---------------------------------------------------------------------------
const runThreshold: WorkoutTemplate = {
  id: 'run.threshold.v1',
  fixed: {
    sport: 'running',
    workoutType: 'threshold',
    title: 'Threshold Run',
    purpose: 'Raise lactate threshold and sustainable high-intensity capacity.',
    intensity: 'high',
    stress: 'high',
    primaryMetric: 'heart_rate',
    allowedMetrics: ['heart_rate', 'pace'],
    phases: [
      { name: 'warmup', label: 'Warm-up', duration: '$warmupDuration', description: 'Includes 4 x 20 s strides.' },
      { name: 'main', label: 'Main set', duration: '$mainDurationTotal', description: '$thresholdRepeats x $thresholdDuration min at HR.threshold / Zone 4, $recoveryDuration min jog between reps.' },
      { name: 'cooldown', label: 'Cool-down', duration: '$cooldownDuration' },
    ],
    contraindications: [
      'latestStimulus.threshold',
      'latestStimulus.vo2max',
      'latestStimulus.anaerobic',
      'fatigue.tired',
      'fatigue.high_risk',
      'hardSessions.atCap',
    ],
    downgradeTo: 'run.aerobic.v1',
    requiredRecoveryHoursAfter: 48,
    minDurationMinutes: 55,
    maxDurationMinutes: 75,
    notes: 'Driven by Garmin Zone 4 / HR.threshold; pace is a reference only. Beginner/intermediate athletes use 2 x 10 min; if heart rate runs abnormally high, switch to an aerobic run immediately.',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 15, unit: 'minutes' } },
    thresholdRepeats: { source: { kind: 'template_default', default: 3, unit: 'reps' } },
    thresholdDuration: { source: { kind: 'template_default', default: 8, unit: 'minutes' } },
    recoveryDuration: { source: { kind: 'template_default', default: 3, unit: 'minutes' } },
    cooldownDuration: { source: { kind: 'template_default', default: 13, unit: 'minutes' } },
    mainDurationTotal: {
      source: { kind: 'derived', from: 'thresholdRepeats,thresholdDuration,recoveryDuration', rule: 'thresholdRepeats * thresholdDuration + (thresholdRepeats - 1) * recoveryDuration', unit: 'minutes' },
    },
    targetHeartRate: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.thresholdRange', unit: 'bpm' } },
    protectiveHrCap: { source: { kind: 'derived', from: 'athleteProfile.heartRate.thresholdRange', rule: 'high bound only', unit: 'bpm' } },
  },
  progression: {
    conservative: { durationMultiplier: 0.8, repeatDelta: -1 },
    normal: { durationMultiplier: 1.0, repeatDelta: 0 },
    aggressive: { durationMultiplier: 1.1, repeatDelta: 1 },
  },
};

// ---------------------------------------------------------------------------
// run.interval.v1 — 间歇跑
// 默认时长 60-75 分钟。5-6 x 800 米 RUN.intervalPace，组间慢跑 400 米或 2-3 分钟。
// ---------------------------------------------------------------------------
const runInterval: WorkoutTemplate = {
  id: 'run.interval.v1',
  fixed: {
    sport: 'running',
    workoutType: 'interval',
    title: 'Interval Run',
    purpose: 'Build 5K-10K specific speed and the ability to repeat hard efforts.',
    intensity: 'high',
    stress: 'high',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: 'Warm-up', duration: '$warmupDuration', description: 'Includes dynamic stretching and 4 x 20 s strides.' },
      { name: 'main', label: 'Main set', duration: '$mainDurationTotal', description: '$intervalRepeats x $intervalDistance m at RUN.intervalPace, $recoveryDistance m jog between reps.' },
      { name: 'cooldown', label: 'Cool-down', duration: '$cooldownDuration' },
    ],
    contraindications: [
      'latestStimulus.threshold',
      'latestStimulus.vo2max',
      'latestStimulus.anaerobic',
      'fatigue.tired',
      'fatigue.high_risk',
      'hardSessions.atCap',
      'confidence.low',
    ],
    downgradeTo: 'run.tempo.v1',
    requiredRecoveryHoursAfter: 48,
    minDurationMinutes: 60,
    maxDurationMinutes: 75,
    notes: 'Not for beginners; downgrade to 6 x 400 m or run.tempo.v1.',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 15, unit: 'minutes' } },
    intervalRepeats: { source: { kind: 'llm_choice', min: 5, max: 6, default: 5, unit: 'reps' } },
    intervalDistance: { source: { kind: 'template_default', default: 800, unit: 'meters' } },
    recoveryDistance: { source: { kind: 'template_default', default: 400, unit: 'meters' } },
    recoveryDuration: { source: { kind: 'template_default', default: 2.5, unit: 'minutes' }, description: 'Time-based alternative to recoveryDistance; use one or the other.' },
    cooldownDuration: { source: { kind: 'template_default', default: 13, unit: 'minutes' } },
    mainDurationTotal: {
      source: { kind: 'derived', from: 'intervalRepeats,intervalDistance,targetPace,recoveryDuration', rule: 'intervalRepeats * intervalDistance / targetPace + (intervalRepeats - 1) * recoveryDuration', unit: 'minutes' },
    },
    targetPace: { source: { kind: 'athlete_profile', path: 'athleteProfile.running.intervalPaceSecPerKm', unit: 's/km' } },
    vo2HrCap: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.vo2CapRange', unit: 'bpm' } },
    totalFastDistance: {
      source: { kind: 'derived', from: 'intervalRepeats,intervalDistance', rule: 'intervalRepeats * intervalDistance', unit: 'meters' },
    },
  },
  progression: PROGRESSION_INTERVAL,
};

// ---------------------------------------------------------------------------
// run.reverse_pyramid.v1 — 倒金字塔间歇跑
// 默认时长 60-75 分钟。1200m + 800m + 400m，距离逐段缩短、速度逐段提高。
// ---------------------------------------------------------------------------
const runReversePyramid: WorkoutTemplate = {
  id: 'run.reverse_pyramid.v1',
  fixed: {
    sport: 'running',
    workoutType: 'reverse_pyramid',
    title: 'Reverse Pyramid Intervals',
    purpose: 'Descending distances keep speed quality high, building speed endurance and the ability to close fast.',
    intensity: 'high',
    stress: 'high',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: 'Warm-up', duration: '$warmupDuration', description: 'Includes dynamic stretching, running drills and 4 x 20 s strides.' },
      { name: 'main', label: 'Main set 1200m + 800m + 400m reverse pyramid', duration: '$mainDurationTotal', description: 'Rep 1 near 10K pace, rep 2 near 5K pace, rep 3 near 3K pace; $recoveryDuration min recovery jog between reps.' },
      { name: 'cooldown', label: 'Cool-down', duration: '$cooldownDuration' },
    ],
    contraindications: [
      'latestStimulus.threshold',
      'latestStimulus.vo2max',
      'latestStimulus.anaerobic',
      'fatigue.tired',
      'fatigue.high_risk',
      'hardSessions.atCap',
      'confidence.low',
    ],
    downgradeTo: 'run.interval.v1',
    requiredRecoveryHoursAfter: 48,
    minDurationMinutes: 60,
    maxDurationMinutes: 75,
    notes: 'Structure is set automatically from ability: 1200m + 800m + 400m with 3 min jog between. If sleep was poor or legs are tired, run the final 400m as a relaxed stride rather than an all-out effort.',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 15, unit: 'minutes' } },
    mainDurationTotal: { source: { kind: 'template_default', default: 22, unit: 'minutes' } },
    recoveryDuration: { source: { kind: 'template_default', default: 3, unit: 'minutes' } },
    cooldownDuration: { source: { kind: 'template_default', default: 13, unit: 'minutes' } },
    targetPace: { source: { kind: 'athlete_profile', path: 'athleteProfile.running.intervalPaceSecPerKm', unit: 's/km' } },
    pyramid1200Pace: {
      source: { kind: 'derived', from: 'athleteProfile.running.intervalPaceSecPerKm', rule: 'intervalPace + 10..+10 s/km', unit: 's/km' },
      description: '1200m rep near 10K pace; must be slower than the 800m rep.',
    },
    pyramid800Pace: {
      source: { kind: 'athlete_profile', path: 'athleteProfile.running.intervalPaceSecPerKm', unit: 's/km' },
      description: '800m rep near 5K pace.',
    },
    pyramid400Pace: {
      source: { kind: 'derived', from: 'athleteProfile.running.intervalPaceSecPerKm', rule: 'intervalPace - 10..-10 s/km', unit: 's/km' },
      description: '400m rep near 3K pace; must be faster than the 800m rep.',
    },
    vo2HrCap: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.vo2CapRange', unit: 'bpm' } },
    totalFastDistance: { source: { kind: 'template_default', default: 2400, unit: 'meters' } },
  },
  progression: PROGRESSION_INTERVAL,
};

// ---------------------------------------------------------------------------
// run.vo2max.v1 — 最大摄氧跑
// 默认时长 55-70 分钟。6 x 3 分钟 RUN.vo2Pace，组间慢跑 3 分钟。
// ---------------------------------------------------------------------------
const runVo2max: WorkoutTemplate = {
  id: 'run.vo2max.v1',
  fixed: {
    sport: 'running',
    workoutType: 'vo2max',
    title: 'VO2max Run',
    purpose: 'Stimulate maximal aerobic capacity (VO2max).',
    intensity: 'high',
    stress: 'high',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: 'Warm-up', duration: '$warmupDuration', description: 'Includes 4 x 20 s strides.' },
      { name: 'main', label: 'Main set', duration: '$mainDurationTotal', description: '$vo2Repeats x $vo2Duration min at RUN.vo2Pace, $recoveryDuration min jog between reps.' },
      { name: 'cooldown', label: 'Cool-down', duration: '$cooldownDuration' },
    ],
    contraindications: [
      'latestStimulus.vo2max',
      'latestStimulus.anaerobic',
      'fatigue.tired',
      'fatigue.high_risk',
      'hardSessions.atCap',
      'confidence.low',
    ],
    downgradeTo: 'run.threshold.v1',
    requiredRecoveryHoursAfter: 72,
    minDurationMinutes: 55,
    maxDurationMinutes: 70,
    notes: 'Not without a stable running base; downgrade to 5 x 2 min or replace with run.threshold.v1.',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 15, unit: 'minutes' } },
    vo2Repeats: { source: { kind: 'template_default', default: 6, unit: 'reps' } },
    vo2Duration: { source: { kind: 'template_default', default: 3, unit: 'minutes' } },
    recoveryDuration: { source: { kind: 'template_default', default: 3, unit: 'minutes' } },
    cooldownDuration: { source: { kind: 'template_default', default: 12, unit: 'minutes' } },
    mainDurationTotal: {
      source: { kind: 'derived', from: 'vo2Repeats,vo2Duration,recoveryDuration', rule: 'vo2Repeats * vo2Duration + (vo2Repeats - 1) * recoveryDuration', unit: 'minutes' },
    },
    targetPace: { source: { kind: 'athlete_profile', path: 'athleteProfile.running.vo2PaceSecPerKm', unit: 's/km' } },
    vo2HrCap: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.vo2CapRange', unit: 'bpm' } },
  },
  progression: PROGRESSION_INTERVAL,
};

// ---------------------------------------------------------------------------
// run.hill.v1 — 坡跑
// 默认时长 45-65 分钟。8-10 x 45-60 秒上坡，恢复 90-120 秒。
// ---------------------------------------------------------------------------
const runHill: WorkoutTemplate = {
  id: 'run.hill.v1',
  fixed: {
    sport: 'running',
    workoutType: 'hill',
    title: 'Hill Repeats',
    purpose: 'Build running-specific strength, climbing ability and neuromuscular recruitment.',
    intensity: 'high',
    stress: 'medium',
    primaryMetric: 'heart_rate',
    allowedMetrics: ['heart_rate'],
    phases: [
      { name: 'warmup', label: 'Warm-up', duration: '$warmupDuration', description: 'Easy running.' },
      { name: 'main', label: 'Main set', duration: '$mainDurationTotal', description: '$hillRepeats x $hillDuration s uphill at RPE 7-8/10, jog or walk down for $recoveryDuration s recovery.' },
      { name: 'cooldown', label: 'Cool-down', duration: '$cooldownDuration' },
    ],
    contraindications: [
      'injury.knee',
      'injury.achilles',
      'injury.calf',
      'latestStimulus.threshold',
      'latestStimulus.vo2max',
      'latestStimulus.anaerobic',
      'hardSessions.atCap',
    ],
    downgradeTo: 'run.strides.v1',
    requiredRecoveryHoursAfter: 48,
    minDurationMinutes: 45,
    maxDurationMinutes: 65,
    notes: 'Downgrade to 6 x 30 s hills or switch to flat run.strides.v1.',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 15, unit: 'minutes' } },
    hillRepeats: { source: { kind: 'llm_choice', min: 8, max: 10, default: 8, unit: 'reps' } },
    hillDuration: { source: { kind: 'llm_choice', min: 45, max: 60, default: 60, unit: 'seconds' } },
    recoveryDuration: { source: { kind: 'llm_choice', min: 90, max: 120, default: 120, unit: 'seconds' } },
    cooldownDuration: { source: { kind: 'template_default', default: 10, unit: 'minutes' } },
    mainDurationTotal: {
      source: { kind: 'derived', from: 'hillRepeats,hillDuration,recoveryDuration', rule: 'hillRepeats * (hillDuration + recoveryDuration) seconds', unit: 'seconds' },
    },
    overallHrCap: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.thresholdRange', unit: 'bpm' }, description: 'Whole main set stays < HR.threshold.high.' },
    recoveryHr: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.aerobicLowRange', unit: 'bpm' } },
    injuryFlags: { source: { kind: 'athlete_profile', path: 'athleteProfile.injuries', optional: true } },
  },
  progression: PROGRESSION_INTERVAL,
};

// ---------------------------------------------------------------------------
// run.strides.v1 — 有氧加速跑
// 默认时长 40-55 分钟。
// ---------------------------------------------------------------------------
const runStrides: WorkoutTemplate = {
  id: 'run.strides.v1',
  fixed: {
    sport: 'running',
    workoutType: 'strides',
    title: 'Aerobic Run + Strides',
    purpose: 'Add neuromuscular activation to a low-stress aerobic session.',
    intensity: 'medium',
    stress: 'low',
    primaryMetric: 'heart_rate',
    allowedMetrics: ['heart_rate'],
    phases: [
      { name: 'warmup', label: 'Warm-up', duration: '$warmupDuration' },
      { name: 'main', label: 'Main set', duration: '$mainDuration', description: 'Hold HR.aerobic.' },
      { name: 'aux', label: 'Strides', duration: '$strideBlockDuration', description: '$strideRepeats x $strideDuration s strides, $strideRecovery s jog between.' },
      { name: 'cooldown', label: 'Cool-down', duration: '$cooldownDuration' },
    ],
    contraindications: ['latestStimulus.anaerobic', 'latestStimulus.sprint'],
    downgradeTo: 'run.aerobic.v1',
    requiredRecoveryHoursAfter: 0,
    minDurationMinutes: 40,
    maxDurationMinutes: 55,
    notes: 'Skip if legs are noticeably sore; downgrade to run.aerobic.v1.',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 10, unit: 'minutes' } },
    mainDuration: { source: { kind: 'llm_choice', min: 25, max: 35, default: 30, unit: 'minutes' } },
    strideRepeats: { source: { kind: 'llm_choice', min: 6, max: 8, default: 8, unit: 'reps' } },
    strideDuration: { source: { kind: 'template_default', default: 20, unit: 'seconds' } },
    strideRecovery: { source: { kind: 'llm_choice', min: 80, max: 100, default: 90, unit: 'seconds' } },
    strideBlockDuration: { source: { kind: 'derived', from: 'strideRepeats,strideDuration,strideRecovery', rule: 'strideRepeats * (strideDuration + strideRecovery) seconds', unit: 'seconds' } },
    cooldownDuration: { source: { kind: 'template_default', default: 5, unit: 'minutes' } },
    targetHeartRate: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.aerobicRange', unit: 'bpm' } },
    strideHrCap: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.thresholdRange', unit: 'bpm' }, description: 'Strides stay below HR.threshold.low.' },
  },
  progression: PROGRESSION_LOW,
};

// ---------------------------------------------------------------------------
// run.progression.v1 — 递进跑
// 默认时长 50-75 分钟。3 x 15 分钟递进。
// ---------------------------------------------------------------------------
const runProgression: WorkoutTemplate = {
  id: 'run.progression.v1',
  fixed: {
    sport: 'running',
    workoutType: 'progression',
    title: 'Progression Run',
    purpose: 'Practice controlled pacing and gradual acceleration in the second half.',
    intensity: 'medium',
    stress: 'medium',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: 'Warm-up', duration: '$warmupDuration' },
      { name: 'main', label: 'Segment 1 – easy', duration: '$segmentDuration', description: 'RUN.easyPace, HR.aerobicLow.' },
      { name: 'main', label: 'Segment 2 – steady aerobic', duration: '$segmentDuration', description: 'RUN.easyPace - 10-20 s/km, HR.aerobic.' },
      { name: 'main', label: 'Segment 3 – strong aerobic', duration: '$segmentDuration', description: 'RUN.progressionFinishPace, HR.aerobic up to the bottom of HR.tempo; do not enter HR.threshold.' },
      { name: 'cooldown', label: 'Cool-down', duration: '$cooldownDuration' },
    ],
    contraindications: ['latestStimulus.threshold', 'latestStimulus.vo2max', 'latestStimulus.anaerobic'],
    downgradeTo: 'run.aerobic.v1',
    requiredRecoveryHoursAfter: 36,
    minDurationMinutes: 50,
    maxDurationMinutes: 75,
    notes: 'Skip in hot weather or on hilly routes where pace can\'t be controlled; keep segment 3 at steady aerobic / bottom of tempo, never threshold.',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 10, unit: 'minutes' } },
    segmentDuration: { source: { kind: 'template_default', default: 15, unit: 'minutes' } },
    cooldownDuration: { source: { kind: 'template_default', default: 8, unit: 'minutes' } },
    easyPace: { source: { kind: 'athlete_profile', path: 'athleteProfile.running.easyPaceSecPerKm', unit: 's/km' } },
    progressionMidPace: {
      source: { kind: 'derived', from: 'athleteProfile.running.easyPaceSecPerKm', rule: 'easyPace - 10..20 s/km', unit: 's/km' },
    },
    targetPace: {
      source: { kind: 'derived', from: 'athleteProfile.running.easyPaceSecPerKm', rule: 'easyPace - 10..25 s/km', unit: 's/km' },
      description: 'Steady aerobic pace for the final progression segment; not threshold/VO2 pace.',
    },
    targetHeartRate: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.aerobicRange', unit: 'bpm' } },
    aerobicLowHr: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.aerobicLowRange', unit: 'bpm' } },
    tempoHr: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.tempoRange', unit: 'bpm' } },
  },
  progression: {
    conservative: { durationMultiplier: 0.85, repeatDelta: 0 },
    normal: { durationMultiplier: 1.0, repeatDelta: 0 },
    aggressive: { durationMultiplier: 1.1, repeatDelta: 0 },
  },
};

// ---------------------------------------------------------------------------
// run.race_pace.v1 — 比赛配速专项
// 默认时长 60-90 分钟。3 x 2 公里 RUN.racePace，组间慢跑 4 分钟；半马/全马 2 x 4 公里。
// ---------------------------------------------------------------------------
const runRacePace: WorkoutTemplate = {
  id: 'run.race_pace.v1',
  fixed: {
    sport: 'running',
    workoutType: 'race_pace',
    title: 'Race Pace Session',
    purpose: 'Supports a specific running race goal.',
    intensity: 'high',
    stress: 'high',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: 'Warm-up', duration: '$warmupDuration' },
      { name: 'main', label: 'Main set', duration: '$mainDurationTotal', description: '$raceRepeats x $raceIntervalDistance km at RUN.racePace, $recoveryDuration min jog between reps.' },
      { name: 'cooldown', label: 'Cool-down', duration: '$cooldownDuration' },
    ],
    contraindications: ['hardSessions.atCap', 'fatigue.tired', 'fatigue.high_risk'],
    downgradeTo: 'run.tempo.v1',
    requiredRecoveryHoursAfter: 48,
    minDurationMinutes: 60,
    maxDurationMinutes: 90,
    notes: 'Not without a target race distance/time. Downgrade to 2 x 2 km or use run.tempo.v1.',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 15, unit: 'minutes' } },
    raceDistance: {
      source: { kind: 'athlete_profile', path: 'athleteProfile.running.raceTargetDistanceKm', optional: true, unit: 'km' },
      description: 'Target race distance; sets the defaults for raceRepeats / raceIntervalDistance.',
    },
    raceRepeats: { source: { kind: 'llm_choice', min: 2, max: 3, default: 3, unit: 'reps' } },
    raceIntervalDistance: { source: { kind: 'llm_choice', min: 2, max: 4, default: 2, unit: 'km' } },
    recoveryDuration: { source: { kind: 'template_default', default: 4, unit: 'minutes' } },
    cooldownDuration: { source: { kind: 'template_default', default: 13, unit: 'minutes' } },
    mainDurationTotal: {
      source: { kind: 'derived', from: 'raceRepeats,raceIntervalDistance,targetPace,recoveryDuration', rule: 'raceRepeats * raceIntervalDistance / targetPace + (raceRepeats - 1) * recoveryDuration', unit: 'minutes' },
    },
    targetPace: { source: { kind: 'athlete_profile', path: 'athleteProfile.running.racePaceSecPerKm', unit: 's/km' } },
    raceHrCap: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.thresholdRange', unit: 'bpm' }, description: 'Cap at HR.threshold.high.' },
  },
  progression: {
    conservative: { durationMultiplier: 0.8, repeatDelta: -1 },
    normal: { durationMultiplier: 1.0, repeatDelta: 0 },
    aggressive: { durationMultiplier: 1.1, repeatDelta: 0 },
  },
};

const runDoubleThresholdAm: WorkoutTemplate = {
  id: 'run.double_threshold_am.v1',
  fixed: {
    sport: 'running',
    workoutType: 'double_threshold',
    title: 'Double Threshold AM',
    purpose: 'Accumulate threshold time at controlled lactate levels; the morning uses shorter timed intervals.',
    intensity: 'high',
    stress: 'high',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: 'Warm-up', duration: '$warmupDuration', description: 'Z2 jog, then 3 x 20 s strides.' },
      { name: 'main', label: 'Main set', duration: '$mainDurationTotal', description: '$thresholdRepeats x $thresholdDuration min @ threshold, $recoveryDuration min jog between reps.' },
      { name: 'cooldown', label: 'Cool-down', duration: '$cooldownDuration' },
    ],
    contraindications: ['fatigue.tired', 'fatigue.high_risk', 'confidence.low'],
    downgradeTo: 'run.threshold.v1',
    requiredRecoveryHoursAfter: 0,
    minDurationMinutes: 50,
    maxDurationMinutes: 70,
    notes: 'Double threshold is only for advanced athletes who are recovering normally; keep total threshold time for the day at 40-70 min, and never let the morning turn into a VO2max session.',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 15, unit: 'minutes' } },
    thresholdRepeats: { source: { kind: 'template_default', default: 5, unit: 'reps' } },
    thresholdDuration: { source: { kind: 'template_default', default: 6, unit: 'minutes' } },
    recoveryDuration: { source: { kind: 'template_default', default: 1, unit: 'minutes' } },
    cooldownDuration: { source: { kind: 'template_default', default: 10, unit: 'minutes' } },
    mainDurationTotal: { source: { kind: 'derived', from: 'thresholdRepeats,thresholdDuration,recoveryDuration', rule: 'thresholdRepeats * thresholdDuration + (thresholdRepeats - 1) * recoveryDuration', unit: 'minutes' } },
    targetPace: { source: { kind: 'athlete_profile', path: 'athleteProfile.running.thresholdPaceSecPerKm', unit: 's/km' } },
    targetHeartRate: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.thresholdRange', unit: 'bpm' } },
  },
  progression: {
    conservative: { durationMultiplier: 0.85, repeatDelta: -1 },
    normal: { durationMultiplier: 1.0, repeatDelta: 0 },
    aggressive: { durationMultiplier: 1.05, repeatDelta: 0 },
  },
};

const runDoubleThresholdPm: WorkoutTemplate = {
  id: 'run.double_threshold_pm.v1',
  fixed: {
    sport: 'running',
    workoutType: 'double_threshold',
    title: 'Double Threshold PM',
    purpose: 'Afternoon 1 km threshold reps to keep accumulating threshold time; pacing must stay rock steady.',
    intensity: 'high',
    stress: 'high',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: 'Warm-up', duration: '$warmupDuration', description: 'Easy run into Z2; confirm fatigue is under control.' },
      { name: 'main', label: 'Main set', duration: '$mainDurationTotal', description: '$thresholdRepeats x $thresholdDistance km @ threshold, $recoveryDuration min jog between reps.' },
      { name: 'cooldown', label: 'Cool-down', duration: '$cooldownDuration' },
    ],
    contraindications: ['fatigue.tired', 'fatigue.high_risk', 'confidence.low'],
    downgradeTo: 'run.aerobic.v1',
    requiredRecoveryHoursAfter: 72,
    minDurationMinutes: 60,
    maxDurationMinutes: 85,
    notes: 'If the morning set drifted noticeably or RPE was higher than expected, the afternoon must be downgraded to Z2 aerobic.',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 15, unit: 'minutes' } },
    thresholdRepeats: { source: { kind: 'template_default', default: 8, unit: 'reps' } },
    thresholdDistance: { source: { kind: 'template_default', default: 1, unit: 'km' } },
    recoveryDuration: { source: { kind: 'template_default', default: 1, unit: 'minutes' } },
    cooldownDuration: { source: { kind: 'template_default', default: 10, unit: 'minutes' } },
    mainDurationTotal: { source: { kind: 'derived', from: 'thresholdRepeats,thresholdDistance,targetPace,recoveryDuration', rule: 'thresholdRepeats * thresholdDistance / targetPace + (thresholdRepeats - 1) * recoveryDuration', unit: 'minutes' } },
    targetPace: { source: { kind: 'athlete_profile', path: 'athleteProfile.running.thresholdPaceSecPerKm', unit: 's/km' } },
    targetHeartRate: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.thresholdRange', unit: 'bpm' } },
  },
  progression: {
    conservative: { durationMultiplier: 0.85, repeatDelta: -2 },
    normal: { durationMultiplier: 1.0, repeatDelta: 0 },
    aggressive: { durationMultiplier: 1.05, repeatDelta: 0 },
  },
};

export const RUNNING_TEMPLATES: Record<string, WorkoutTemplate> = {
  [runRecovery.id]: runRecovery,
  [runAerobic.id]: runAerobic,
  [runLsd.id]: runLsd,
  [runTempo.id]: runTempo,
  [runThreshold.id]: runThreshold,
  [runInterval.id]: runInterval,
  [runReversePyramid.id]: runReversePyramid,
  [runVo2max.id]: runVo2max,
  [runHill.id]: runHill,
  [runStrides.id]: runStrides,
  [runProgression.id]: runProgression,
  [runRacePace.id]: runRacePace,
  [runDoubleThresholdAm.id]: runDoubleThresholdAm,
  [runDoubleThresholdPm.id]: runDoubleThresholdPm,
};
