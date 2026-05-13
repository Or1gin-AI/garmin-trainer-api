// Cycling templates (U5).
//
// Translated verbatim from the cofounder spec
// "training-plan-generation-refactor.md → 骑行模板".
//
// Cycling-specific rules (per spec):
//   - targetPace 永远是 不适用 → templates do NOT expose a targetPace variable.
//   - targetPace 永远是 不适用 → templates do NOT expose a targetPace variable.
//   - 有 FTP 时，除恢复/踏频技术课外优先使用 targetPower；心率作为保护上限。
//   - 缺 FTP 时 parameterizer 会自动降级到 heart_rate。

import type { WorkoutTemplate } from './types.js';

const PROG_LOW: WorkoutTemplate['progression'] = {
  conservative: { durationMultiplier: 0.85, repeatDelta: 0 },
  normal: { durationMultiplier: 1.0, repeatDelta: 0 },
  aggressive: { durationMultiplier: 1.1, repeatDelta: 0 },
};

const PROG_INTERVAL: WorkoutTemplate['progression'] = {
  conservative: { durationMultiplier: 0.8, repeatDelta: -1 },
  normal: { durationMultiplier: 1.0, repeatDelta: 0 },
  aggressive: { durationMultiplier: 1.1, repeatDelta: 1 },
};

const PROG_AEROBIC: WorkoutTemplate['progression'] = {
  conservative: { durationMultiplier: 0.8, repeatDelta: 0 },
  normal: { durationMultiplier: 1.0, repeatDelta: 0 },
  aggressive: { durationMultiplier: 1.15, repeatDelta: 0 },
};

// ---------------------------------------------------------------------------
// bike.recovery_spin.v1 — 恢复骑
// 默认时长 35-50 分钟。
// ---------------------------------------------------------------------------
const bikeRecoverySpin: WorkoutTemplate = {
  id: 'bike.recovery_spin.v1',
  fixed: {
    sport: 'cycling',
    workoutType: 'recovery_spin',
    title: '恢复骑',
    purpose: '恢复和低压力活动。',
    intensity: 'low',
    stress: 'low',
    primaryMetric: 'heart_rate',
    allowedMetrics: ['heart_rate', 'power'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupDuration', description: '踏频 85-95 rpm。' },
      { name: 'main', label: '主训练', duration: '$mainDuration', description: '心率保持恢复区间。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownDuration' },
    ],
    contraindications: [],
    downgradeTo: 'rest.full.v1',
    requiredRecoveryHoursAfter: 0,
    minDurationMinutes: 35,
    maxDurationMinutes: 50,
    notes: '疲劳高时改为完全休息或 20 分钟轻松转腿。',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 10, unit: 'minutes' } },
    mainDuration: { source: { kind: 'llm_choice', min: 20, max: 35, default: 25, unit: 'minutes' } },
    cooldownDuration: { source: { kind: 'template_default', default: 5, unit: 'minutes' } },
    targetHeartRate: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.recoveryRange', unit: 'bpm' } },
    recoveryPowerCap: {
      source: { kind: 'derived', from: 'athleteProfile.cycling.ftpWatts', rule: '<55% FTP', unit: 'W', optional: true },
    },
    cadenceRange: { source: { kind: 'template_default', default: '85-95 rpm' } },
  },
  progression: PROG_LOW,
};

// ---------------------------------------------------------------------------
// bike.endurance.v1 — Z2 耐力骑
// 默认时长 60-90 分钟。
// ---------------------------------------------------------------------------
const bikeEndurance: WorkoutTemplate = {
  id: 'bike.endurance.v1',
  fixed: {
    sport: 'cycling',
    workoutType: 'endurance',
    title: 'Z2 耐力骑',
    purpose: '有氧基础和骑行经济性。',
    intensity: 'low',
    stress: 'medium',
    primaryMetric: 'power',
    allowedMetrics: ['power', 'heart_rate'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupDuration' },
      { name: 'main', label: '主训练', duration: '$mainDuration', description: '心率保持 BIKE.enduranceHr，踏频 85-95 rpm。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownDuration' },
    ],
    contraindications: ['fatigue.high_risk'],
    downgradeTo: 'bike.recovery_spin.v1',
    requiredRecoveryHoursAfter: 0,
    minDurationMinutes: 60,
    maxDurationMinutes: 90,
    notes: '训练负荷上升过快时缩短到 45-60 分钟。',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 10, unit: 'minutes' } },
    mainDuration: { source: { kind: 'llm_choice', min: 45, max: 70, default: 55, unit: 'minutes' } },
    cooldownDuration: { source: { kind: 'template_default', default: 8, unit: 'minutes' } },
    targetHeartRate: { source: { kind: 'athlete_profile', path: 'athleteProfile.cycling.enduranceHrRange', unit: 'bpm' } },
    endurancePowerRange: {
      source: { kind: 'derived', from: 'athleteProfile.cycling.ftpWatts', rule: '56-75% FTP', unit: 'W', optional: true },
    },
    cadenceRange: { source: { kind: 'template_default', default: '85-95 rpm' } },
  },
  progression: PROG_AEROBIC,
};

// ---------------------------------------------------------------------------
// bike.long_ride.v1 — 长距离耐力骑
// 默认时长 90-180 分钟。
// ---------------------------------------------------------------------------
const bikeLongRide: WorkoutTemplate = {
  id: 'bike.long_ride.v1',
  fixed: {
    sport: 'cycling',
    workoutType: 'long_ride',
    title: '长距离耐力骑',
    purpose: '发展长时间耐力和补给执行能力。',
    intensity: 'low',
    stress: 'high',
    primaryMetric: 'power',
    allowedMetrics: ['power', 'heart_rate'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupDuration' },
      { name: 'main', label: '主训练', duration: '$mainDuration', description: '稳定耐力骑，每 $fuelingIntervalMinutes 分钟检查补水和主观疲劳。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownDuration' },
    ],
    contraindications: ['latestStimulus.threshold', 'latestStimulus.vo2max', 'latestStimulus.anaerobic', 'fatigue.high_risk'],
    downgradeTo: 'bike.endurance.v1',
    requiredRecoveryHoursAfter: 36,
    minDurationMinutes: 90,
    maxDurationMinutes: 180,
    notes: '降级为 bike.endurance.v1 60-75 分钟。',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 15, unit: 'minutes' } },
    mainDuration: { source: { kind: 'llm_choice', min: 70, max: 150, default: 100, unit: 'minutes' } },
    cooldownDuration: { source: { kind: 'template_default', default: 13, unit: 'minutes' } },
    targetHeartRate: { source: { kind: 'athlete_profile', path: 'athleteProfile.cycling.enduranceHrRange', unit: 'bpm' }, description: '前半段靠近下沿。' },
    longRidePowerRange: {
      source: { kind: 'derived', from: 'athleteProfile.cycling.ftpWatts', rule: '56-72% FTP', unit: 'W', optional: true },
    },
    fuelingIntervalMinutes: { source: { kind: 'template_default', default: 30, unit: 'minutes' } },
    hydrationReminder: { source: { kind: 'template_default', default: '每 30 分钟补水' } },
  },
  progression: PROG_AEROBIC,
};

// ---------------------------------------------------------------------------
// bike.tempo.v1 — Tempo 骑
// 默认时长 60-90 分钟。3 x 12 分钟 Tempo，组间轻松骑 5 分钟。
// ---------------------------------------------------------------------------
const bikeTempo: WorkoutTemplate = {
  id: 'bike.tempo.v1',
  fixed: {
    sport: 'cycling',
    workoutType: 'tempo',
    title: 'Tempo 骑',
    purpose: '提高中等强度持续输出。',
    intensity: 'medium',
    stress: 'medium',
    primaryMetric: 'power',
    allowedMetrics: ['heart_rate', 'power'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupDuration' },
      { name: 'main', label: '主训练', duration: '$mainDurationTotal', description: '$tempoRepeats x $tempoDuration 分钟 Tempo，组间轻松骑 $recoveryDuration 分钟。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownDuration' },
    ],
    contraindications: ['latestStimulus.threshold', 'latestStimulus.vo2max', 'latestStimulus.anaerobic'],
    downgradeTo: 'bike.endurance.v1',
    requiredRecoveryHoursAfter: 48,
    minDurationMinutes: 60,
    maxDurationMinutes: 90,
    notes: '降级为 2 x 12 分钟或 bike.endurance.v1。',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 15, unit: 'minutes' } },
    tempoRepeats: { source: { kind: 'template_default', default: 3, unit: 'reps' } },
    tempoDuration: { source: { kind: 'template_default', default: 12, unit: 'minutes' } },
    recoveryDuration: { source: { kind: 'template_default', default: 5, unit: 'minutes' } },
    cooldownDuration: { source: { kind: 'template_default', default: 14, unit: 'minutes' } },
    mainDurationTotal: {
      source: { kind: 'derived', from: 'tempoRepeats,tempoDuration,recoveryDuration', rule: 'tempoRepeats * tempoDuration + (tempoRepeats - 1) * recoveryDuration', unit: 'minutes' },
    },
    targetHeartRate: { source: { kind: 'athlete_profile', path: 'athleteProfile.cycling.tempoHrRange', unit: 'bpm' } },
    tempoPowerRange: {
      source: { kind: 'derived', from: 'athleteProfile.cycling.ftpWatts', rule: '76-87% FTP', unit: 'W', optional: true },
    },
  },
  progression: PROG_INTERVAL,
};

// ---------------------------------------------------------------------------
// bike.sweet_spot.v1 — 甜区骑 (FTP-required template)
// 默认时长 75-90 分钟。3 x 12 分钟甜区。
// ---------------------------------------------------------------------------
const bikeSweetSpot: WorkoutTemplate = {
  id: 'bike.sweet_spot.v1',
  fixed: {
    sport: 'cycling',
    workoutType: 'sweet_spot',
    title: '甜区骑',
    purpose: '提高接近阈值的有氧输出，收益高但压力可控。',
    intensity: 'high',
    stress: 'high',
    primaryMetric: 'power',
    allowedMetrics: ['power', 'heart_rate'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupDuration', description: '含 3 x 1 分钟高踏频。' },
      { name: 'main', label: '主训练', duration: '$mainDurationTotal', description: '$sweetSpotRepeats x $sweetSpotDuration 分钟甜区，组间轻松骑 $recoveryDuration 分钟。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownDuration' },
    ],
    contraindications: ['hardSessions.atCap', 'fatigue.tired', 'fatigue.high_risk', 'confidence.low'],
    downgradeTo: 'bike.tempo.v1',
    requiredRecoveryHoursAfter: 48,
    minDurationMinutes: 75,
    maxDurationMinutes: 90,
    notes: '无 FTP 且没有稳定骑行训练历史时禁用。',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 15, unit: 'minutes' } },
    sweetSpotRepeats: { source: { kind: 'template_default', default: 3, unit: 'reps' } },
    sweetSpotDuration: { source: { kind: 'template_default', default: 12, unit: 'minutes' } },
    recoveryDuration: { source: { kind: 'template_default', default: 5, unit: 'minutes' } },
    cooldownDuration: { source: { kind: 'template_default', default: 14, unit: 'minutes' } },
    mainDurationTotal: {
      source: { kind: 'derived', from: 'sweetSpotRepeats,sweetSpotDuration,recoveryDuration', rule: 'sweetSpotRepeats * sweetSpotDuration + (sweetSpotRepeats - 1) * recoveryDuration', unit: 'minutes' },
    },
    sweetSpotPowerRange: {
      source: { kind: 'derived', from: 'athleteProfile.cycling.ftpWatts', rule: '88-94% FTP', unit: 'W' },
      description: '需要 FTP；缺失时降级为 bike.tempo.v1。',
    },
    tempoHr: { source: { kind: 'athlete_profile', path: 'athleteProfile.cycling.tempoHrRange', unit: 'bpm' } },
    thresholdHrLow: { source: { kind: 'athlete_profile', path: 'athleteProfile.cycling.thresholdHrRange', unit: 'bpm' }, description: 'low bound only' },
  },
  progression: PROG_INTERVAL,
};

// ---------------------------------------------------------------------------
// bike.threshold.v1 — 阈值骑
// 默认时长 75-95 分钟。2 x 20 分钟阈值，组间轻松骑 8 分钟。
// ---------------------------------------------------------------------------
const bikeThreshold: WorkoutTemplate = {
  id: 'bike.threshold.v1',
  fixed: {
    sport: 'cycling',
    workoutType: 'threshold',
    title: '阈值骑',
    purpose: '提高 FTP 和阈值附近持续能力。',
    intensity: 'high',
    stress: 'high',
    primaryMetric: 'power',
    allowedMetrics: ['power', 'heart_rate'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupDuration', description: '含 3 x 1 分钟接近阈值。' },
      { name: 'main', label: '主训练', duration: '$mainDurationTotal', description: '$thresholdRepeats x $thresholdDuration 分钟阈值，组间轻松骑 $recoveryDuration 分钟。' },
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
    downgradeTo: 'bike.sweet_spot.v1',
    requiredRecoveryHoursAfter: 48,
    minDurationMinutes: 75,
    maxDurationMinutes: 95,
    notes: '有 FTP 时以 95-100% FTP 为主，心率作为阈值保护上限；缺 FTP 时降级为心率阈值骑。',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 20, unit: 'minutes' } },
    thresholdRepeats: { source: { kind: 'template_default', default: 2, unit: 'reps' } },
    thresholdDuration: { source: { kind: 'template_default', default: 20, unit: 'minutes' } },
    recoveryDuration: { source: { kind: 'template_default', default: 8, unit: 'minutes' } },
    cooldownDuration: { source: { kind: 'template_default', default: 13, unit: 'minutes' } },
    mainDurationTotal: {
      source: { kind: 'derived', from: 'thresholdRepeats,thresholdDuration,recoveryDuration', rule: 'thresholdRepeats * thresholdDuration + (thresholdRepeats - 1) * recoveryDuration', unit: 'minutes' },
    },
    targetHeartRate: { source: { kind: 'athlete_profile', path: 'athleteProfile.cycling.thresholdHrRange', unit: 'bpm' } },
    thresholdPowerRange: {
      source: { kind: 'derived', from: 'athleteProfile.cycling.ftpWatts', rule: '95-100% FTP', unit: 'W', optional: true },
    },
  },
  progression: PROG_INTERVAL,
};

// ---------------------------------------------------------------------------
// bike.vo2max.v1 — VO2max 骑
// 默认时长 60-80 分钟。5 x 3 分钟 VO2max，组间轻松骑 3 分钟。
// ---------------------------------------------------------------------------
const bikeVo2max: WorkoutTemplate = {
  id: 'bike.vo2max.v1',
  fixed: {
    sport: 'cycling',
    workoutType: 'vo2max',
    title: 'VO2max 骑',
    purpose: '提升高强度摄氧能力。',
    intensity: 'high',
    stress: 'high',
    primaryMetric: 'power',
    allowedMetrics: ['power', 'heart_rate'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupDuration' },
      { name: 'main', label: '主训练', duration: '$mainDurationTotal', description: '$vo2Repeats x $vo2Duration 分钟 VO2max，组间轻松骑 $recoveryDuration 分钟，恢复段回到 BIKE.enduranceHr。' },
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
    downgradeTo: 'bike.threshold.v1',
    requiredRecoveryHoursAfter: 72,
    minDurationMinutes: 60,
    maxDurationMinutes: 80,
    notes: '有 FTP 时以 110-120% FTP 为主，心率只作保护上限；缺功率时降级为 bike.threshold.v1。',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 20, unit: 'minutes' } },
    vo2Repeats: { source: { kind: 'template_default', default: 5, unit: 'reps' } },
    vo2Duration: { source: { kind: 'template_default', default: 3, unit: 'minutes' } },
    recoveryDuration: { source: { kind: 'template_default', default: 3, unit: 'minutes' } },
    cooldownDuration: { source: { kind: 'template_default', default: 13, unit: 'minutes' } },
    mainDurationTotal: {
      source: { kind: 'derived', from: 'vo2Repeats,vo2Duration,recoveryDuration', rule: 'vo2Repeats * vo2Duration + (vo2Repeats - 1) * recoveryDuration', unit: 'minutes' },
    },
    vo2HrCap: { source: { kind: 'athlete_profile', path: 'athleteProfile.cycling.vo2HrCapRange', unit: 'bpm' } },
    enduranceHr: { source: { kind: 'athlete_profile', path: 'athleteProfile.cycling.enduranceHrRange', unit: 'bpm' } },
    vo2PowerRange: {
      source: { kind: 'derived', from: 'athleteProfile.cycling.ftpWatts', rule: '110-120% FTP', unit: 'W', optional: true },
    },
  },
  progression: PROG_INTERVAL,
};

// ---------------------------------------------------------------------------
// bike.anaerobic.v1 — 无氧容量骑
// 默认时长 50-70 分钟。8 x 1 分钟高强度，组间轻松骑 3 分钟。
// ---------------------------------------------------------------------------
const bikeAnaerobic: WorkoutTemplate = {
  id: 'bike.anaerobic.v1',
  fixed: {
    sport: 'cycling',
    workoutType: 'anaerobic',
    title: '无氧容量骑',
    purpose: '提高短时间高功率重复能力。',
    intensity: 'high',
    stress: 'high',
    primaryMetric: 'power',
    allowedMetrics: ['power', 'heart_rate'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupDuration' },
      { name: 'main', label: '主训练', duration: '$mainDurationTotal', description: '$anaerobicRepeats x $anaerobicDuration 分钟高强度，组间轻松骑 $recoveryDuration 分钟。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownDuration' },
    ],
    contraindications: [
      'latestStimulus.anaerobic',
      'latestStimulus.vo2max',
      'fatigue.tired',
      'fatigue.high_risk',
      'hardSessions.atCap',
      'confidence.low',
    ],
    downgradeTo: 'bike.vo2max.v1',
    requiredRecoveryHoursAfter: 72,
    minDurationMinutes: 50,
    maxDurationMinutes: 70,
    notes: '有 FTP 时以 120-140% FTP 为主，心率不适合作为 1 分钟间歇主目标。初级用户禁用。',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 20, unit: 'minutes' } },
    anaerobicRepeats: { source: { kind: 'template_default', default: 8, unit: 'reps' } },
    anaerobicDuration: { source: { kind: 'template_default', default: 1, unit: 'minutes' } },
    recoveryDuration: { source: { kind: 'template_default', default: 3, unit: 'minutes' } },
    cooldownDuration: { source: { kind: 'template_default', default: 12, unit: 'minutes' } },
    mainDurationTotal: {
      source: { kind: 'derived', from: 'anaerobicRepeats,anaerobicDuration,recoveryDuration', rule: 'anaerobicRepeats * anaerobicDuration + (anaerobicRepeats - 1) * recoveryDuration', unit: 'minutes' },
    },
    vo2HrCap: { source: { kind: 'athlete_profile', path: 'athleteProfile.cycling.vo2HrCapRange', unit: 'bpm' } },
    enduranceHrCap: { source: { kind: 'athlete_profile', path: 'athleteProfile.cycling.enduranceHrRange', unit: 'bpm' }, description: '恢复段低于 BIKE.enduranceHr.high。' },
    anaerobicPowerRange: {
      source: { kind: 'derived', from: 'athleteProfile.cycling.ftpWatts', rule: '120-140% FTP', unit: 'W', optional: true },
    },
    eligibility: {
      source: { kind: 'athlete_profile', path: 'athleteProfile.experienceLevel' },
      description: '初级用户禁用，仅 intermediate/advanced 启用。',
    },
  },
  progression: PROG_INTERVAL,
};

// ---------------------------------------------------------------------------
// bike.sprint.v1 — 冲刺骑
// 默认时长 45-60 分钟。8-10 x 12 秒全力冲刺。
// ---------------------------------------------------------------------------
const bikeSprint: WorkoutTemplate = {
  id: 'bike.sprint.v1',
  fixed: {
    sport: 'cycling',
    workoutType: 'sprint',
    title: '冲刺骑',
    purpose: '神经肌肉冲刺能力，不追求心肺负荷。',
    intensity: 'high',
    stress: 'medium',
    primaryMetric: 'power',
    allowedMetrics: ['power', 'heart_rate'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupDuration' },
      { name: 'main', label: '主训练', duration: '$mainDurationTotal', description: '$sprintRepeats x $sprintDurationSeconds 秒全力冲刺，组间轻松骑 $sprintRecoveryMinutes 分钟。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownDuration' },
    ],
    contraindications: [
      'injury.knee',
      'injury.lower_back',
      'latestStimulus.anaerobic',
      'latestStimulus.sprint',
      'confidence.low',
    ],
    downgradeTo: 'bike.cadence_drill.v1',
    requiredRecoveryHoursAfter: 48,
    minDurationMinutes: 45,
    maxDurationMinutes: 60,
    notes: '冲刺以短时功率/全力输出为主，心率只约束非冲刺恢复段。初级用户禁用。',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 20, unit: 'minutes' } },
    sprintRepeats: { source: { kind: 'llm_choice', min: 8, max: 10, default: 8, unit: 'reps' } },
    sprintDurationSeconds: { source: { kind: 'template_default', default: 12, unit: 'seconds' } },
    sprintRecoveryMinutes: { source: { kind: 'llm_choice', min: 3, max: 4, default: 4, unit: 'minutes' } },
    cooldownDuration: { source: { kind: 'template_default', default: 10, unit: 'minutes' } },
    mainDurationTotal: {
      source: { kind: 'derived', from: 'sprintRepeats,sprintDurationSeconds,sprintRecoveryMinutes', rule: 'sprintRepeats * (sprintDurationSeconds/60 + sprintRecoveryMinutes)', unit: 'minutes' },
    },
    targetHeartRate: { source: { kind: 'athlete_profile', path: 'athleteProfile.cycling.enduranceHrRange', unit: 'bpm' }, description: '非冲刺时间。' },
    vo2HrCap: { source: { kind: 'athlete_profile', path: 'athleteProfile.cycling.vo2HrCapRange', unit: 'bpm' } },
    sprintPowerFloor: {
      source: { kind: 'derived', from: 'athleteProfile.cycling.ftpWatts', rule: '>150% FTP 或全力 12 秒', unit: 'W', optional: true },
    },
  },
  progression: {
    conservative: { durationMultiplier: 0.8, repeatDelta: -2 },
    normal: { durationMultiplier: 1.0, repeatDelta: 0 },
    aggressive: { durationMultiplier: 1.0, repeatDelta: 1 },
  },
};

// ---------------------------------------------------------------------------
// bike.cadence_drill.v1 — 踏频技术骑
// 默认时长 45-60 分钟。6 x 4 分钟高踏频 100-110 rpm。
// ---------------------------------------------------------------------------
const bikeCadenceDrill: WorkoutTemplate = {
  id: 'bike.cadence_drill.v1',
  fixed: {
    sport: 'cycling',
    workoutType: 'cadence_drill',
    title: '踏频技术骑',
    purpose: '改善踏频控制和踩踏效率。',
    intensity: 'low',
    stress: 'low',
    primaryMetric: 'heart_rate',
    allowedMetrics: ['heart_rate', 'power'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupDuration' },
      { name: 'main', label: '主训练', duration: '$mainDurationTotal', description: '$drillRepeats x $drillDuration 分钟高踏频 $cadenceHighRange，组间 $drillRecovery 分钟 $cadenceNormalRange。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownDuration' },
    ],
    contraindications: [],
    downgradeTo: 'bike.recovery_spin.v1',
    requiredRecoveryHoursAfter: 0,
    minDurationMinutes: 45,
    maxDurationMinutes: 60,
    notes: '减少到 4 组作为降级。',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 10, unit: 'minutes' } },
    drillRepeats: { source: { kind: 'template_default', default: 6, unit: 'reps' } },
    drillDuration: { source: { kind: 'template_default', default: 4, unit: 'minutes' } },
    drillRecovery: { source: { kind: 'template_default', default: 3, unit: 'minutes' } },
    cooldownDuration: { source: { kind: 'template_default', default: 8, unit: 'minutes' } },
    mainDurationTotal: {
      source: { kind: 'derived', from: 'drillRepeats,drillDuration,drillRecovery', rule: 'drillRepeats * (drillDuration + drillRecovery) - drillRecovery', unit: 'minutes' },
    },
    cadenceHighRange: { source: { kind: 'template_default', default: '100-110 rpm' } },
    cadenceNormalRange: { source: { kind: 'template_default', default: '85-90 rpm' } },
    targetHeartRate: { source: { kind: 'athlete_profile', path: 'athleteProfile.cycling.enduranceHrRange', unit: 'bpm' }, description: '取下沿。' },
    drillPowerRange: {
      source: { kind: 'derived', from: 'athleteProfile.cycling.ftpWatts', rule: '55-70% FTP', unit: 'W', optional: true },
    },
  },
  progression: {
    conservative: { durationMultiplier: 0.85, repeatDelta: -2 },
    normal: { durationMultiplier: 1.0, repeatDelta: 0 },
    aggressive: { durationMultiplier: 1.05, repeatDelta: 0 },
  },
};

// ---------------------------------------------------------------------------
// bike.climb.v1 — 爬坡专项骑
// 默认时长 60-90 分钟。4 x 8 分钟爬坡或低踏频。
// ---------------------------------------------------------------------------
const bikeClimb: WorkoutTemplate = {
  id: 'bike.climb.v1',
  fixed: {
    sport: 'cycling',
    workoutType: 'climb',
    title: '爬坡专项骑',
    purpose: '提高低踏频稳定输出和爬坡耐受。',
    intensity: 'high',
    stress: 'medium',
    primaryMetric: 'power',
    allowedMetrics: ['power', 'heart_rate'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupDuration' },
      { name: 'main', label: '主训练', duration: '$mainDurationTotal', description: '$climbRepeats x $climbDuration 分钟爬坡或低踏频 $lowCadenceRange，组间轻松骑 $recoveryDuration 分钟。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownDuration' },
    ],
    contraindications: ['injury.knee', 'latestStimulus.threshold', 'latestStimulus.vo2max'],
    downgradeTo: 'bike.tempo.v1',
    requiredRecoveryHoursAfter: 36,
    minDurationMinutes: 60,
    maxDurationMinutes: 90,
    notes: '无爬坡环境时改室内低踏频。降级为 3 x 6 分钟。',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 15, unit: 'minutes' } },
    climbRepeats: { source: { kind: 'template_default', default: 4, unit: 'reps' } },
    climbDuration: { source: { kind: 'template_default', default: 8, unit: 'minutes' } },
    recoveryDuration: { source: { kind: 'template_default', default: 5, unit: 'minutes' } },
    cooldownDuration: { source: { kind: 'template_default', default: 12, unit: 'minutes' } },
    mainDurationTotal: {
      source: { kind: 'derived', from: 'climbRepeats,climbDuration,recoveryDuration', rule: 'climbRepeats * climbDuration + (climbRepeats - 1) * recoveryDuration', unit: 'minutes' },
    },
    targetHeartRate: { source: { kind: 'athlete_profile', path: 'athleteProfile.cycling.tempoHrRange', unit: 'bpm' }, description: 'BIKE.tempoHr 到 BIKE.thresholdHr.low。' },
    thresholdHrLow: { source: { kind: 'athlete_profile', path: 'athleteProfile.cycling.thresholdHrRange', unit: 'bpm' } },
    climbPowerRange: {
      source: { kind: 'derived', from: 'athleteProfile.cycling.ftpWatts', rule: '80-95% FTP', unit: 'W', optional: true },
    },
    lowCadenceRange: { source: { kind: 'template_default', default: '60-75 rpm' } },
  },
  progression: PROG_INTERVAL,
};

// ---------------------------------------------------------------------------
// bike.over_under.v1 — 阈值上下浮动骑 (FTP-required template)
// 默认时长 75-95 分钟。3 x 12 分钟 over-under。
// ---------------------------------------------------------------------------
const bikeOverUnder: WorkoutTemplate = {
  id: 'bike.over_under.v1',
  fixed: {
    sport: 'cycling',
    workoutType: 'over_under',
    title: '阈值上下浮动骑',
    purpose: '提高阈值附近变速耐受和乳酸清除能力。',
    intensity: 'high',
    stress: 'high',
    primaryMetric: 'power',
    allowedMetrics: ['power', 'heart_rate'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupDuration' },
      {
        name: 'main',
        label: '主训练',
        duration: '$mainDurationTotal',
        description: '$blockRepeats x $blockDuration 分钟，每组内重复 $inBlockPattern (2 分钟 95% FTP + 1 分钟 105% FTP)，组间轻松骑 $recoveryDuration 分钟。',
      },
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
    downgradeTo: 'bike.threshold.v1',
    requiredRecoveryHoursAfter: 72,
    minDurationMinutes: 75,
    maxDurationMinutes: 95,
    notes: '没有 FTP 时降级为 bike.threshold.v1 或 bike.sweet_spot.v1。',
  },
  variables: {
    warmupDuration: { source: { kind: 'template_default', default: 20, unit: 'minutes' } },
    blockRepeats: { source: { kind: 'template_default', default: 3, unit: 'reps' } },
    blockDuration: { source: { kind: 'template_default', default: 12, unit: 'minutes' } },
    recoveryDuration: { source: { kind: 'template_default', default: 6, unit: 'minutes' } },
    cooldownDuration: { source: { kind: 'template_default', default: 13, unit: 'minutes' } },
    mainDurationTotal: {
      source: { kind: 'derived', from: 'blockRepeats,blockDuration,recoveryDuration', rule: 'blockRepeats * blockDuration + (blockRepeats - 1) * recoveryDuration', unit: 'minutes' },
    },
    inBlockPattern: { source: { kind: 'template_default', default: '2 分钟 under + 1 分钟 over' } },
    underPower: {
      source: { kind: 'derived', from: 'athleteProfile.cycling.ftpWatts', rule: '95% FTP', unit: 'W' },
    },
    overPower: {
      source: { kind: 'derived', from: 'athleteProfile.cycling.ftpWatts', rule: '105% FTP', unit: 'W' },
    },
    targetHeartRate: { source: { kind: 'athlete_profile', path: 'athleteProfile.cycling.thresholdHrRange', unit: 'bpm' } },
  },
  progression: {
    conservative: { durationMultiplier: 0.8, repeatDelta: -1 },
    normal: { durationMultiplier: 1.0, repeatDelta: 0 },
    aggressive: { durationMultiplier: 1.1, repeatDelta: 1 },
  },
};

export const CYCLING_TEMPLATES: Record<string, WorkoutTemplate> = {
  [bikeRecoverySpin.id]: bikeRecoverySpin,
  [bikeEndurance.id]: bikeEndurance,
  [bikeLongRide.id]: bikeLongRide,
  [bikeTempo.id]: bikeTempo,
  [bikeSweetSpot.id]: bikeSweetSpot,
  [bikeThreshold.id]: bikeThreshold,
  [bikeVo2max.id]: bikeVo2max,
  [bikeAnaerobic.id]: bikeAnaerobic,
  [bikeSprint.id]: bikeSprint,
  [bikeCadenceDrill.id]: bikeCadenceDrill,
  [bikeClimb.id]: bikeClimb,
  [bikeOverUnder.id]: bikeOverUnder,
};
