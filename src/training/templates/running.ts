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
    title: '恢复跑',
    purpose: '促进恢复，不制造新的训练压力。',
    intensity: 'low',
    stress: 'low',
    primaryMetric: 'heart_rate',
    allowedMetrics: ['heart_rate'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupDuration', description: '心率进入 HR.recovery。' },
      { name: 'main', label: '主训练', duration: '$mainDuration', description: '心率保持 HR.recovery，RPE 2-3/10。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownDuration', description: '心率低于 HR.recovery.high。' },
    ],
    contraindications: [],
    downgradeTo: 'rest.walk.v1',
    requiredRecoveryHoursAfter: 0,
    minDurationMinutes: 30,
    maxDurationMinutes: 45,
    notes: '疲劳为 high_risk 时改为 20-30 分钟快走或完全休息。',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 5, unit: 'minutes' } },
    mainDuration: { source: { kind: 'template_default', default: 25, unit: 'minutes' } },
    cooldownDuration: { source: { kind: 'template_default', default: 5, unit: 'minutes' } },
    targetHeartRate: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.recoveryRange', unit: 'bpm' } },
    targetPaceCap: {
      source: { kind: 'derived', from: 'athleteProfile.running.easyPaceSecPerKm', rule: '+20 s/km (上限，可选)', optional: true, unit: 's/km' },
      description: '若用户强依赖配速，可写 "慢于 RUN.easyPace 20 秒/km"。否则 targetPace = 不适用。',
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
    title: '普通有氧跑',
    purpose: '维持有氧基础，作为周计划的基础训练。',
    intensity: 'low',
    stress: 'medium',
    primaryMetric: 'heart_rate',
    allowedMetrics: ['heart_rate', 'pace'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupDuration', description: 'HR.recovery 到 HR.zone2。' },
      { name: 'main', label: '主训练', duration: '$mainDuration', description: '保持 HR.zone2。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownDuration', description: '心率回到 HR.recovery。' },
    ],
    contraindications: ['fatigue.high_risk'],
    downgradeTo: 'run.recovery.v1',
    requiredRecoveryHoursAfter: 0,
    minDurationMinutes: 40,
    maxDurationMinutes: 65,
    notes: '以 Garmin Zone 2 / HR.aerobic 为主，不使用配速上限。最新可靠活动为 vo2max/anaerobic 且疲劳偏高时不安排超过 45 分钟；7 天负荷快速上升时主训练缩短 20%。',
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
      description: 'auto = 优先心率，配速稳定时可切到 pace；由 parameterizer 决定。',
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
    title: 'LSD 长距离有氧跑',
    purpose: '提高有氧基础、脂代谢能力和长时间耐受。',
    intensity: 'low',
    stress: 'high',
    primaryMetric: 'heart_rate',
    allowedMetrics: ['heart_rate'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupDuration', description: '心率逐步进入 HR.zone2。' },
      { name: 'main', label: '主训练', duration: '$mainDuration', description: '心率保持 HR.zone2，中途不做提速。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownDuration', description: '心率降至 HR.recovery。' },
    ],
    contraindications: ['latestStimulus.threshold', 'latestStimulus.vo2max', 'latestStimulus.anaerobic', 'fatigue.high_risk'],
    downgradeTo: 'run.aerobic.v1',
    requiredRecoveryHoursAfter: 36,
    minDurationMinutes: 70,
    maxDurationMinutes: 110,
    notes: '初级用户 50-75 分钟。最新训练负荷偏高时降级为 run.aerobic.v1 45-60 分钟。',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 10, unit: 'minutes' } },
    mainDuration: {
      source: { kind: 'athlete_profile', path: 'athleteProfile.running.lsdMainDurationMinutes', min: 50, max: 90, unit: 'minutes' },
    },
    cooldownDuration: { source: { kind: 'template_default', default: 10, unit: 'minutes' } },
    targetHeartRate: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.zone2Range', unit: 'bpm' } },
    distanceKm: {
      source: { kind: 'derived', from: 'mainDuration + targetHeartRate', rule: 'LSD 以心率为主，不用配速反推距离', optional: true, unit: 'km' },
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
    title: '节奏跑',
    purpose: '提高中高强度巡航能力，低于阈值但有持续压力。',
    intensity: 'medium',
    stress: 'medium',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupDuration', description: '末端 4 x 20 秒轻快加速，组间慢跑 60 秒。' },
      { name: 'main', label: '主训练', duration: '$mainDurationTotal', description: '$tempoRepeats x $tempoDuration 分钟 RUN.tempoPace，组间慢跑 $recoveryDuration 分钟。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownDuration', description: '心率回到 HR.recovery。' },
    ],
    contraindications: ['latestStimulus.threshold', 'latestStimulus.vo2max', 'latestStimulus.anaerobic'],
    downgradeTo: 'run.aerobic.v1',
    requiredRecoveryHoursAfter: 48,
    minDurationMinutes: 50,
    maxDurationMinutes: 70,
    notes: '初级用户改为 3 x 6 分钟；疲劳偏高时改为 run.aerobic.v1。',
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
    protectiveHrCap: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.thresholdRange', unit: 'bpm' }, description: '上限取 HR.threshold.high。' },
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
    title: '阈值跑',
    purpose: '提高乳酸阈值和可持续高强度能力。',
    intensity: 'high',
    stress: 'high',
    primaryMetric: 'heart_rate',
    allowedMetrics: ['heart_rate', 'pace'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupDuration', description: '含 4 x 20 秒加速。' },
      { name: 'main', label: '主训练', duration: '$mainDurationTotal', description: '$thresholdRepeats x $thresholdDuration 分钟 HR.threshold / Zone 4，组间慢跑 $recoveryDuration 分钟。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownDuration' },
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
    notes: '以 Garmin Zone 4 / HR.threshold 为主；配速仅作参考。中低水平用户用 2 x 10 分钟；心率异常偏高时立即改为有氧跑。',
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
    title: '间歇跑',
    purpose: '提高 5K-10K 专项速度和高强度重复能力。',
    intensity: 'high',
    stress: 'high',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupDuration', description: '含动态拉伸和 4 x 20 秒加速。' },
      { name: 'main', label: '主训练', duration: '$mainDurationTotal', description: '$intervalRepeats x $intervalDistance 米 RUN.intervalPace，组间慢跑 $recoveryDistance 米。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownDuration' },
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
    notes: '初级用户禁用；降级为 6 x 400 米或 run.tempo.v1。',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 15, unit: 'minutes' } },
    intervalRepeats: { source: { kind: 'llm_choice', min: 5, max: 6, default: 5, unit: 'reps' } },
    intervalDistance: { source: { kind: 'template_default', default: 800, unit: '米' } },
    recoveryDistance: { source: { kind: 'template_default', default: 400, unit: '米' } },
    recoveryDuration: { source: { kind: 'template_default', default: 2.5, unit: 'minutes' }, description: '替代 recoveryDistance 的时间口径，二选一。' },
    cooldownDuration: { source: { kind: 'template_default', default: 13, unit: 'minutes' } },
    mainDurationTotal: {
      source: { kind: 'derived', from: 'intervalRepeats,intervalDistance,targetPace,recoveryDuration', rule: 'intervalRepeats * intervalDistance / targetPace + (intervalRepeats - 1) * recoveryDuration', unit: 'minutes' },
    },
    targetPace: { source: { kind: 'athlete_profile', path: 'athleteProfile.running.intervalPaceSecPerKm', unit: 's/km' } },
    vo2HrCap: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.vo2CapRange', unit: 'bpm' } },
    totalFastDistance: {
      source: { kind: 'derived', from: 'intervalRepeats,intervalDistance', rule: 'intervalRepeats * intervalDistance', unit: '米' },
    },
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
    title: '最大摄氧跑',
    purpose: '刺激最大摄氧能力。',
    intensity: 'high',
    stress: 'high',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupDuration', description: '含 4 x 20 秒加速。' },
      { name: 'main', label: '主训练', duration: '$mainDurationTotal', description: '$vo2Repeats x $vo2Duration 分钟 RUN.vo2Pace，组间慢跑 $recoveryDuration 分钟。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownDuration' },
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
    notes: '没有稳定跑步基础时禁用；降级为 5 x 2 分钟或替换为 run.threshold.v1。',
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
    title: '坡跑',
    purpose: '提升跑姿力量、爬坡能力和神经肌肉招募。',
    intensity: 'high',
    stress: 'medium',
    primaryMetric: 'heart_rate',
    allowedMetrics: ['heart_rate'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupDuration', description: '轻松跑。' },
      { name: 'main', label: '主训练', duration: '$mainDurationTotal', description: '$hillRepeats x $hillDuration 秒上坡，RPE 7-8/10，慢跑或走下坡恢复 $recoveryDuration 秒。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownDuration' },
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
    notes: '降级为 6 x 30 秒坡跑或换成平路 run.strides.v1。',
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
    overallHrCap: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.thresholdRange', unit: 'bpm' }, description: '主训练整体 < HR.threshold.high。' },
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
    title: '有氧加速跑',
    purpose: '在低压力有氧课中加入神经激活。',
    intensity: 'medium',
    stress: 'low',
    primaryMetric: 'heart_rate',
    allowedMetrics: ['heart_rate'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupDuration' },
      { name: 'main', label: '主训练', duration: '$mainDuration', description: '保持 HR.aerobic。' },
      { name: 'aux', label: '加速跑', duration: '$strideBlockDuration', description: '$strideRepeats x $strideDuration 秒加速跑，组间慢跑 $strideRecovery 秒。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownDuration' },
    ],
    contraindications: ['latestStimulus.anaerobic', 'latestStimulus.sprint'],
    downgradeTo: 'run.aerobic.v1',
    requiredRecoveryHoursAfter: 0,
    minDurationMinutes: 40,
    maxDurationMinutes: 55,
    notes: '腿部酸痛明显时禁用；降级为 run.aerobic.v1。',
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
    strideHrCap: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.thresholdRange', unit: 'bpm' }, description: '加速段不超 HR.threshold.low。' },
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
    title: '递进跑',
    purpose: '练习后半程控制和逐步提速。',
    intensity: 'medium',
    stress: 'medium',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupDuration' },
      { name: 'main', label: '第一段 轻松', duration: '$segmentDuration', description: 'RUN.easyPace，HR.aerobicLow。' },
      { name: 'main', label: '第二段 有氧偏快', duration: '$segmentDuration', description: 'RUN.easyPace - 10-20 秒/km，HR.aerobic。' },
      { name: 'main', label: '第三段 稳态有氧', duration: '$segmentDuration', description: 'RUN.progressionFinishPace，HR.aerobic 到 HR.tempo 下沿；不进入 HR.threshold。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownDuration' },
    ],
    contraindications: ['latestStimulus.threshold', 'latestStimulus.vo2max', 'latestStimulus.anaerobic'],
    downgradeTo: 'run.aerobic.v1',
    requiredRecoveryHoursAfter: 36,
    minDurationMinutes: 50,
    maxDurationMinutes: 75,
    notes: '天气炎热或坡度大配速不可控时禁用；第三段控制在稳态有氧/Tempo 下沿，不做阈值跑。',
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
      description: '渐进跑最后一段的稳态有氧配速，不使用阈值/VO2 配速。',
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
    title: '比赛配速专项',
    purpose: '服务明确跑步比赛目标。',
    intensity: 'high',
    stress: 'high',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupDuration' },
      { name: 'main', label: '主训练', duration: '$mainDurationTotal', description: '$raceRepeats x $raceIntervalDistance 公里 RUN.racePace，组间慢跑 $recoveryDuration 分钟。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownDuration' },
    ],
    contraindications: ['hardSessions.atCap', 'fatigue.tired', 'fatigue.high_risk'],
    downgradeTo: 'run.tempo.v1',
    requiredRecoveryHoursAfter: 48,
    minDurationMinutes: 60,
    maxDurationMinutes: 90,
    notes: '没有目标距离/目标时间时禁用。降级为 2 x 2 公里或使用 run.tempo.v1。',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 15, unit: 'minutes' } },
    raceDistance: {
      source: { kind: 'athlete_profile', path: 'athleteProfile.running.raceTargetDistanceKm', optional: true, unit: 'km' },
      description: '比赛目标距离，决定 raceRepeats / raceIntervalDistance 的默认值。',
    },
    raceRepeats: { source: { kind: 'llm_choice', min: 2, max: 3, default: 3, unit: 'reps' } },
    raceIntervalDistance: { source: { kind: 'llm_choice', min: 2, max: 4, default: 2, unit: 'km' } },
    recoveryDuration: { source: { kind: 'template_default', default: 4, unit: 'minutes' } },
    cooldownDuration: { source: { kind: 'template_default', default: 13, unit: 'minutes' } },
    mainDurationTotal: {
      source: { kind: 'derived', from: 'raceRepeats,raceIntervalDistance,targetPace,recoveryDuration', rule: 'raceRepeats * raceIntervalDistance / targetPace + (raceRepeats - 1) * recoveryDuration', unit: 'minutes' },
    },
    targetPace: { source: { kind: 'athlete_profile', path: 'athleteProfile.running.racePaceSecPerKm', unit: 's/km' } },
    raceHrCap: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.thresholdRange', unit: 'bpm' }, description: '上限取 HR.threshold.high。' },
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
    title: '双阈值 AM',
    purpose: '在可控乳酸水平下累积阈值时间，上午使用较短时间间歇。',
    intensity: 'high',
    stress: 'high',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupDuration', description: 'Z2 慢跑后加入 3 x 20 秒加速。' },
      { name: 'main', label: '主训练', duration: '$mainDurationTotal', description: '$thresholdRepeats x $thresholdDuration 分钟 @ threshold，组间 $recoveryDuration 分钟慢跑。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownDuration' },
    ],
    contraindications: ['fatigue.tired', 'fatigue.high_risk', 'confidence.low'],
    downgradeTo: 'run.threshold.v1',
    requiredRecoveryHoursAfter: 0,
    minDurationMinutes: 50,
    maxDurationMinutes: 70,
    notes: '双阈值只给高水平且恢复正常的用户；全天阈值总时间控制在 40-70 分钟，上午不能跑成 VO2max。',
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
    title: '双阈值 PM',
    purpose: '下午用 1km 阈值重复跑继续累积阈值时间，保持配速绝对稳定。',
    intensity: 'high',
    stress: 'high',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupDuration', description: '轻松跑到 Z2，确认疲劳可控。' },
      { name: 'main', label: '主训练', duration: '$mainDurationTotal', description: '$thresholdRepeats x $thresholdDistance 公里 @ threshold，组间 $recoveryDuration 分钟慢跑。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownDuration' },
    ],
    contraindications: ['fatigue.tired', 'fatigue.high_risk', 'confidence.low'],
    downgradeTo: 'run.aerobic.v1',
    requiredRecoveryHoursAfter: 72,
    minDurationMinutes: 60,
    maxDurationMinutes: 85,
    notes: '如果上午主项漂移明显或 RPE 超预期，下午必须降级为 Z2 有氧。',
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
  [runVo2max.id]: runVo2max,
  [runHill.id]: runHill,
  [runStrides.id]: runStrides,
  [runProgression.id]: runProgression,
  [runRacePace.id]: runRacePace,
  [runDoubleThresholdAm.id]: runDoubleThresholdAm,
  [runDoubleThresholdPm.id]: runDoubleThresholdPm,
};
