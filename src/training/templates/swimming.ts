// Swimming templates (U5).
//
// Translated verbatim from the cofounder spec
// "training-plan-generation-refactor.md → 游泳模板".
//
// Swim-specific rules:
//   - Paces in s/100m. totalMeters always in metres.
//   - Per-rep distances are multiples of 25 (works for both 25m and 50m pools).
//   - V1 does not branch by pool length; parameterizer adjusts rep counts based
//     on athleteProfile.swimming.poolLengthM if needed.
//   - Templates expose totalMeters + per-rep distance variables.

import type { WorkoutTemplate } from './types.js';

const PROG_LOW: WorkoutTemplate['progression'] = {
  conservative: { durationMultiplier: 0.8, repeatDelta: -1 },
  normal: { durationMultiplier: 1.0, repeatDelta: 0 },
  aggressive: { durationMultiplier: 1.1, repeatDelta: 1 },
};

const PROG_INTERVAL: WorkoutTemplate['progression'] = {
  conservative: { durationMultiplier: 0.8, repeatDelta: -2 },
  normal: { durationMultiplier: 1.0, repeatDelta: 0 },
  aggressive: { durationMultiplier: 1.1, repeatDelta: 1 },
};

// ---------------------------------------------------------------------------
// swim.recovery.v1 — 恢复游
// 默认总量 1000-1800 米。
// ---------------------------------------------------------------------------
const swimRecovery: WorkoutTemplate = {
  id: 'swim.recovery.v1',
  fixed: {
    sport: 'swimming',
    workoutType: 'recovery',
    title: '恢复游',
    purpose: '恢复和水感维持。',
    intensity: 'low',
    stress: 'low',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupMeters 米', description: '轻松游。' },
      { name: 'drill', label: '技术段', duration: '$drillTotalMeters 米', description: '$drillRepeats x $drillDistance 米轻松 drill，组间休息 $drillRest 秒。' },
      { name: 'main', label: '主训练', duration: '$mainTotalMeters 米', description: '$mainRepeats x $mainDistance 米轻松游，组间休息 $restSeconds 秒。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownMeters 米' },
    ],
    contraindications: [],
    downgradeTo: 'rest.mobility.v1',
    requiredRecoveryHoursAfter: 0,
    minDurationMinutes: 25,
    maxDurationMinutes: 50,
    notes: '疲劳高时总量降到 800-1200 米。',
  },
  variables: {
    totalMeters: { source: { kind: 'llm_choice', min: 1000, max: 1800, default: 1400, unit: '米' } },
    warmupMeters: { source: { kind: 'template_default', default: 200, unit: '米' } },
    drillRepeats: { source: { kind: 'template_default', default: 6, unit: 'reps' } },
    drillDistance: { source: { kind: 'template_default', default: 50, unit: '米' } },
    drillRest: { source: { kind: 'template_default', default: 20, unit: 'seconds' } },
    drillTotalMeters: {
      source: { kind: 'derived', from: 'drillRepeats,drillDistance', rule: 'drillRepeats * drillDistance', unit: '米' },
    },
    mainRepeats: { source: { kind: 'llm_choice', min: 4, max: 6, default: 5, unit: 'reps' } },
    mainDistance: { source: { kind: 'template_default', default: 100, unit: '米' } },
    restSeconds: { source: { kind: 'llm_choice', min: 20, max: 30, default: 25, unit: 'seconds' } },
    mainTotalMeters: {
      source: { kind: 'derived', from: 'mainRepeats,mainDistance', rule: 'mainRepeats * mainDistance', unit: '米' },
    },
    cooldownMeters: { source: { kind: 'llm_choice', min: 100, max: 200, default: 200, unit: '米' } },
    easyPaceCap: {
      source: { kind: 'derived', from: 'athleteProfile.swimming.easyPaceSecPer100m', rule: '+5..15 s/100m (上限)', unit: 's/100m' },
    },
    aerobicLowHrCap: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.aerobicLowRange', unit: 'bpm' } },
  },
  progression: PROG_LOW,
};

// ---------------------------------------------------------------------------
// swim.technique.v1 — 技术游
// 默认总量 1200-2000 米。
// ---------------------------------------------------------------------------
const swimTechnique: WorkoutTemplate = {
  id: 'swim.technique.v1',
  fixed: {
    sport: 'swimming',
    workoutType: 'technique',
    title: '技术游',
    purpose: '改进划水、换气、身体位置和水感。',
    intensity: 'low',
    stress: 'low',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupMeters 米', description: '轻松游。' },
      { name: 'drill', label: '技术段', duration: '$drillTotalMeters 米', description: '$drillRepeats x $drillDistance 米 drill：单臂、追逐游、侧身打腿、换气练习各 2 组，组间 $drillRest 秒。' },
      { name: 'main', label: '主训练', duration: '$mainTotalMeters 米', description: '$mainRepeats x $mainDistance 米轻松自由泳，专注动作，组间 $restSeconds 秒。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownMeters 米' },
    ],
    contraindications: [],
    downgradeTo: 'swim.recovery.v1',
    requiredRecoveryHoursAfter: 0,
    minDurationMinutes: 30,
    maxDurationMinutes: 55,
    notes: '若用户不会对应 drill，替换为 10 x 50 米轻松自由泳技术关注。',
  },
  variables: {
    totalMeters: { source: { kind: 'llm_choice', min: 1200, max: 2000, default: 1800, unit: '米' } },
    warmupMeters: { source: { kind: 'template_default', default: 300, unit: '米' } },
    drillList: { source: { kind: 'template_default', default: '单臂/追逐游/侧身打腿/换气' } },
    drillRepeats: { source: { kind: 'template_default', default: 8, unit: 'reps' } },
    drillDistance: { source: { kind: 'template_default', default: 50, unit: '米' } },
    drillRest: { source: { kind: 'template_default', default: 20, unit: 'seconds' } },
    drillTotalMeters: {
      source: { kind: 'derived', from: 'drillRepeats,drillDistance', rule: 'drillRepeats * drillDistance', unit: '米' },
    },
    mainRepeats: { source: { kind: 'template_default', default: 6, unit: 'reps' } },
    mainDistance: { source: { kind: 'template_default', default: 100, unit: '米' } },
    restSeconds: { source: { kind: 'llm_choice', min: 20, max: 30, default: 25, unit: 'seconds' } },
    mainTotalMeters: {
      source: { kind: 'derived', from: 'mainRepeats,mainDistance', rule: 'mainRepeats * mainDistance', unit: '米' },
    },
    cooldownMeters: { source: { kind: 'template_default', default: 200, unit: '米' } },
    easyPaceCap: { source: { kind: 'athlete_profile', path: 'athleteProfile.swimming.easyPaceSecPer100m', unit: 's/100m' } },
    aerobicLowHrCap: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.aerobicLowRange', unit: 'bpm' } },
  },
  progression: PROG_LOW,
};

// ---------------------------------------------------------------------------
// swim.aerobic.v1 — 有氧游
// 默认总量 1600-2600 米。
// ---------------------------------------------------------------------------
const swimAerobic: WorkoutTemplate = {
  id: 'swim.aerobic.v1',
  fixed: {
    sport: 'swimming',
    workoutType: 'aerobic',
    title: '有氧游',
    purpose: '提高游泳有氧能力。',
    intensity: 'medium',
    stress: 'medium',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupMeters 米' },
      { name: 'main', label: '主训练', duration: '$mainTotalMeters 米', description: '$aerobicRepeats x $aerobicDistance 米 SWIM.aerobicPace，组间休息 $restSeconds 秒。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownMeters 米' },
    ],
    contraindications: ['fatigue.high_risk'],
    downgradeTo: 'swim.recovery.v1',
    requiredRecoveryHoursAfter: 0,
    minDurationMinutes: 35,
    maxDurationMinutes: 65,
    notes: '降级为 8-10 x 100 米或总量减少 20%。',
  },
  variables: {
    totalMeters: { source: { kind: 'llm_choice', min: 1600, max: 2600, default: 2200, unit: '米' } },
    warmupMeters: { source: { kind: 'template_default', default: 300, unit: '米' } },
    aerobicRepeats: { source: { kind: 'llm_choice', min: 6, max: 8, default: 8, unit: 'reps' } },
    aerobicDistance: { source: { kind: 'template_default', default: 200, unit: '米' } },
    restSeconds: { source: { kind: 'llm_choice', min: 20, max: 30, default: 25, unit: 'seconds' } },
    mainTotalMeters: {
      source: { kind: 'derived', from: 'aerobicRepeats,aerobicDistance', rule: 'aerobicRepeats * aerobicDistance', unit: '米' },
    },
    cooldownMeters: { source: { kind: 'template_default', default: 300, unit: '米' } },
    targetPace: { source: { kind: 'athlete_profile', path: 'athleteProfile.swimming.aerobicPaceSecPer100m', unit: 's/100m' } },
    aerobicHrCap: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.aerobicRange', unit: 'bpm' } },
  },
  progression: PROG_INTERVAL,
};

// ---------------------------------------------------------------------------
// swim.endurance.v1 — 长组耐力游
// 默认总量 2200-3500 米。3 x 600 米 SWIM.endurancePace，组间休息 45-60 秒。
// ---------------------------------------------------------------------------
const swimEndurance: WorkoutTemplate = {
  id: 'swim.endurance.v1',
  fixed: {
    sport: 'swimming',
    workoutType: 'endurance',
    title: '长组耐力游',
    purpose: '提高连续游和长距离耐受。',
    intensity: 'medium',
    stress: 'medium',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupMeters 米' },
      { name: 'main', label: '主训练', duration: '$mainTotalMeters 米', description: '$enduranceRepeats x $enduranceDistance 米 SWIM.endurancePace，组间休息 $restSeconds 秒。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownMeters 米' },
    ],
    contraindications: ['confidence.low', 'fatigue.high_risk'],
    downgradeTo: 'swim.aerobic.v1',
    requiredRecoveryHoursAfter: 24,
    minDurationMinutes: 45,
    maxDurationMinutes: 75,
    notes: '降级为 4 x 300 米或 swim.aerobic.v1。游泳基础不足或近期没有 1500 米以上记录时禁用。',
  },
  variables: {
    totalMeters: { source: { kind: 'llm_choice', min: 2200, max: 3500, default: 2500, unit: '米' } },
    warmupMeters: { source: { kind: 'template_default', default: 400, unit: '米' } },
    enduranceRepeats: { source: { kind: 'template_default', default: 3, unit: 'reps' } },
    enduranceDistance: { source: { kind: 'template_default', default: 600, unit: '米' } },
    restSeconds: { source: { kind: 'llm_choice', min: 45, max: 60, default: 60, unit: 'seconds' } },
    mainTotalMeters: {
      source: { kind: 'derived', from: 'enduranceRepeats,enduranceDistance', rule: 'enduranceRepeats * enduranceDistance', unit: '米' },
    },
    cooldownMeters: { source: { kind: 'llm_choice', min: 200, max: 300, default: 300, unit: '米' } },
    targetPace: { source: { kind: 'athlete_profile', path: 'athleteProfile.swimming.endurancePaceSecPer100m', unit: 's/100m' } },
    aerobicHrCap: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.aerobicRange', unit: 'bpm' } },
    minimumRecentSwimMeters: { source: { kind: 'template_default', default: 1500, unit: '米' }, description: '前置门槛：近期至少 1 次 1500m+ 游。' },
  },
  progression: PROG_INTERVAL,
};

// ---------------------------------------------------------------------------
// swim.css_threshold.v1 — CSS/阈值游
// 默认总量 1800-3000 米。8 x 100 米 CSS 配速，组间休息 20 秒。
// ---------------------------------------------------------------------------
const swimCssThreshold: WorkoutTemplate = {
  id: 'swim.css_threshold.v1',
  fixed: {
    sport: 'swimming',
    workoutType: 'css_threshold',
    title: 'CSS / 阈值游',
    purpose: '提高 CSS 阈值和中长距离速度。',
    intensity: 'high',
    stress: 'high',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupMeters 米', description: '含 4 x 50 米逐渐加速。' },
      { name: 'main', label: '主训练', duration: '$mainTotalMeters 米', description: '$cssRepeats x $cssDistance 米 CSS 配速，组间休息 $restSeconds 秒；中高级可用 4 x 200 米。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownMeters 米' },
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
    downgradeTo: 'swim.aerobic.v1',
    requiredRecoveryHoursAfter: 48,
    minDurationMinutes: 40,
    maxDurationMinutes: 70,
    notes: '没有 CSS 或可靠泳池配速时禁用。降级为 swim.aerobic.v1 或 6 x 100 米。',
  },
  variables: {
    totalMeters: { source: { kind: 'llm_choice', min: 1800, max: 3000, default: 2200, unit: '米' } },
    warmupMeters: { source: { kind: 'template_default', default: 400, unit: '米' } },
    cssRepeats: { source: { kind: 'template_default', default: 8, unit: 'reps' } },
    cssDistance: { source: { kind: 'template_default', default: 100, unit: '米' } },
    restSeconds: { source: { kind: 'template_default', default: 20, unit: 'seconds' } },
    mainTotalMeters: {
      source: { kind: 'derived', from: 'cssRepeats,cssDistance', rule: 'cssRepeats * cssDistance', unit: '米' },
    },
    cooldownMeters: { source: { kind: 'llm_choice', min: 200, max: 300, default: 300, unit: '米' } },
    cssPace: { source: { kind: 'athlete_profile', path: 'athleteProfile.swimming.cssPaceSecPer100m', unit: 's/100m' } },
    cssPaceRange: {
      source: { kind: 'derived', from: 'athleteProfile.swimming.cssPaceSecPer100m', rule: 'cssPace 到 cssPace + 5 s/100m', unit: 's/100m' },
    },
    thresholdHrCap: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.thresholdRange', unit: 'bpm' } },
  },
  progression: PROG_INTERVAL,
};

// ---------------------------------------------------------------------------
// swim.vo2max.v1 — VO2max 游
// 默认总量 1600-2600 米。12 x 100 米 SWIM.vo2Pace，组间休息 30-40 秒。
// ---------------------------------------------------------------------------
const swimVo2max: WorkoutTemplate = {
  id: 'swim.vo2max.v1',
  fixed: {
    sport: 'swimming',
    workoutType: 'vo2max',
    title: 'VO2max 游',
    purpose: '提高快速重复游能力和摄氧刺激。',
    intensity: 'high',
    stress: 'high',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupMeters 米' },
      { name: 'main', label: '主训练', duration: '$mainTotalMeters 米', description: '$vo2Repeats x $vo2Distance 米 SWIM.vo2Pace，组间休息 $restSeconds 秒。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownMeters 米' },
    ],
    contraindications: [
      'latestStimulus.vo2max',
      'latestStimulus.anaerobic',
      'fatigue.tired',
      'fatigue.high_risk',
      'hardSessions.atCap',
      'confidence.low',
    ],
    downgradeTo: 'swim.css_threshold.v1',
    requiredRecoveryHoursAfter: 72,
    minDurationMinutes: 35,
    maxDurationMinutes: 60,
    notes: '初级游泳者禁用。降级为 8 x 100 米或替换为 swim.css_threshold.v1。',
  },
  variables: {
    totalMeters: { source: { kind: 'llm_choice', min: 1600, max: 2600, default: 2100, unit: '米' } },
    warmupMeters: { source: { kind: 'template_default', default: 400, unit: '米' } },
    vo2Repeats: { source: { kind: 'template_default', default: 12, unit: 'reps' } },
    vo2Distance: { source: { kind: 'template_default', default: 100, unit: '米' } },
    restSeconds: { source: { kind: 'llm_choice', min: 30, max: 40, default: 35, unit: 'seconds' } },
    mainTotalMeters: {
      source: { kind: 'derived', from: 'vo2Repeats,vo2Distance', rule: 'vo2Repeats * vo2Distance', unit: '米' },
    },
    cooldownMeters: { source: { kind: 'template_default', default: 200, unit: '米' } },
    targetPace: { source: { kind: 'athlete_profile', path: 'athleteProfile.swimming.vo2PaceSecPer100m', unit: 's/100m' } },
    vo2HrCap: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.vo2CapRange', unit: 'bpm' } },
  },
  progression: PROG_INTERVAL,
};

// ---------------------------------------------------------------------------
// swim.sprint.v1 — 短冲游
// 默认总量 1200-2200 米。16 x 25 米快速。
// ---------------------------------------------------------------------------
const swimSprint: WorkoutTemplate = {
  id: 'swim.sprint.v1',
  fixed: {
    sport: 'swimming',
    workoutType: 'sprint',
    title: '短冲游',
    purpose: '提高短距离速度和神经肌肉招募。',
    intensity: 'high',
    stress: 'medium',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupMeters 米', description: '含 4 x 25 米渐进加速。' },
      { name: 'main', label: '主训练', duration: '$mainTotalMeters 米', description: '$sprintRepeats x $sprintDistance 米快速 SWIM.sprintPace，组间休息 $sprintRestSeconds 秒。' },
      { name: 'aux', label: '辅助', duration: '$auxTotalMeters 米', description: '$easyAuxRepeats x 50 米轻松技术游，组间 20 秒。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownMeters 米' },
    ],
    contraindications: ['injury.shoulder', 'latestStimulus.anaerobic', 'latestStimulus.sprint'],
    downgradeTo: 'swim.aerobic.v1',
    requiredRecoveryHoursAfter: 48,
    minDurationMinutes: 30,
    maxDurationMinutes: 55,
    notes: '降级为 8-12 x 25 米。',
  },
  variables: {
    totalMeters: { source: { kind: 'llm_choice', min: 1200, max: 2200, default: 1700, unit: '米' } },
    warmupMeters: { source: { kind: 'template_default', default: 400, unit: '米' } },
    sprintRepeats: { source: { kind: 'llm_choice', min: 8, max: 16, default: 16, unit: 'reps' } },
    sprintDistance: { source: { kind: 'template_default', default: 25, unit: '米' } },
    sprintRestSeconds: { source: { kind: 'llm_choice', min: 30, max: 45, default: 40, unit: 'seconds' } },
    mainTotalMeters: {
      source: { kind: 'derived', from: 'sprintRepeats,sprintDistance', rule: 'sprintRepeats * sprintDistance', unit: '米' },
    },
    easyAuxRepeats: { source: { kind: 'template_default', default: 6, unit: 'reps' } },
    auxTotalMeters: {
      source: { kind: 'derived', from: 'easyAuxRepeats', rule: 'easyAuxRepeats * 50', unit: '米' },
    },
    cooldownMeters: { source: { kind: 'template_default', default: 200, unit: '米' } },
    sprintPace: { source: { kind: 'athlete_profile', path: 'athleteProfile.swimming.sprintPaceSecPer100m', unit: 's/100m' } },
    easyPace: { source: { kind: 'athlete_profile', path: 'athleteProfile.swimming.easyPaceSecPer100m', unit: 's/100m' } },
    vo2HrCap: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.vo2CapRange', unit: 'bpm' } },
  },
  progression: {
    conservative: { durationMultiplier: 0.75, repeatDelta: -4 },
    normal: { durationMultiplier: 1.0, repeatDelta: 0 },
    aggressive: { durationMultiplier: 1.0, repeatDelta: 2 },
  },
};

// ---------------------------------------------------------------------------
// swim.pull.v1 — 划手专项
// 默认总量 1600-2800 米。
// ---------------------------------------------------------------------------
const swimPull: WorkoutTemplate = {
  id: 'swim.pull.v1',
  fixed: {
    sport: 'swimming',
    workoutType: 'pull',
    title: '划手专项',
    purpose: '强化上肢划水效率和持续拉水能力。',
    intensity: 'medium',
    stress: 'medium',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupMeters 米' },
      { name: 'drill', label: '技术段', duration: '$drillTotalMeters 米', description: '4 x 50 米划水感觉 drill。' },
      { name: 'main', label: '主训练', duration: '$mainTotalMeters 米', description: '$pullRepeats x $pullDistance 米 pull buoy，可选划手掌，组间休息 $restSeconds 秒。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownMeters 米' },
    ],
    contraindications: ['injury.shoulder'],
    downgradeTo: 'swim.technique.v1',
    requiredRecoveryHoursAfter: 24,
    minDurationMinutes: 35,
    maxDurationMinutes: 65,
    notes: '划手掌不适时仅用 pull buoy 或改技术游。',
  },
  variables: {
    totalMeters: { source: { kind: 'llm_choice', min: 1600, max: 2800, default: 2100, unit: '米' } },
    warmupMeters: { source: { kind: 'template_default', default: 300, unit: '米' } },
    drillRepeats: { source: { kind: 'template_default', default: 4, unit: 'reps' } },
    drillDistance: { source: { kind: 'template_default', default: 50, unit: '米' } },
    drillTotalMeters: {
      source: { kind: 'derived', from: 'drillRepeats,drillDistance', rule: 'drillRepeats * drillDistance', unit: '米' },
    },
    pullRepeats: { source: { kind: 'template_default', default: 8, unit: 'reps' } },
    pullDistance: { source: { kind: 'template_default', default: 100, unit: '米' } },
    restSeconds: { source: { kind: 'llm_choice', min: 20, max: 30, default: 25, unit: 'seconds' } },
    mainTotalMeters: {
      source: { kind: 'derived', from: 'pullRepeats,pullDistance', rule: 'pullRepeats * pullDistance', unit: '米' },
    },
    cooldownMeters: { source: { kind: 'template_default', default: 200, unit: '米' } },
    targetPace: {
      source: { kind: 'derived', from: 'athleteProfile.swimming.cssPaceSecPer100m', rule: 'aerobicPace 到 cssPace + 8 s/100m', unit: 's/100m' },
    },
    aerobicHrCap: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.aerobicRange', unit: 'bpm' } },
    equipment: { source: { kind: 'template_default', default: 'pull buoy + (可选)划手掌' } },
    shoulderFlag: { source: { kind: 'athlete_profile', path: 'athleteProfile.injuries', optional: true } },
  },
  progression: PROG_LOW,
};

// ---------------------------------------------------------------------------
// swim.kick.v1 — 打腿专项
// 默认总量 1200-2200 米。
// ---------------------------------------------------------------------------
const swimKick: WorkoutTemplate = {
  id: 'swim.kick.v1',
  fixed: {
    sport: 'swimming',
    workoutType: 'kick',
    title: '打腿专项',
    purpose: '强化腿部推进和身体位置控制。',
    intensity: 'low',
    stress: 'low',
    primaryMetric: 'heart_rate',
    allowedMetrics: ['heart_rate', 'pace'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupMeters 米' },
      { name: 'main', label: '主训练', duration: '$mainTotalMeters 米', description: '$kickRepeats x $kickDistance 米打腿，组间休息 $kickRestSeconds 秒。' },
      { name: 'aux', label: '辅助', duration: '$auxTotalMeters 米', description: '$freeRepeats x 100 米轻松自由泳，不快于 SWIM.easyPace，组间休息 20 秒。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownMeters 米' },
    ],
    contraindications: ['injury.knee', 'injury.hip'],
    downgradeTo: 'swim.technique.v1',
    requiredRecoveryHoursAfter: 0,
    minDurationMinutes: 30,
    maxDurationMinutes: 55,
    notes: '髋/膝/脚踝不适时禁用。降级为打腿减少到 4-6 组或夹板技术游。',
  },
  variables: {
    totalMeters: { source: { kind: 'llm_choice', min: 1200, max: 2200, default: 1700, unit: '米' } },
    warmupMeters: { source: { kind: 'template_default', default: 300, unit: '米' } },
    kickRepeats: { source: { kind: 'template_default', default: 8, unit: 'reps' } },
    kickDistance: { source: { kind: 'template_default', default: 50, unit: '米' } },
    kickRestSeconds: { source: { kind: 'llm_choice', min: 25, max: 35, default: 30, unit: 'seconds' } },
    mainTotalMeters: {
      source: { kind: 'derived', from: 'kickRepeats,kickDistance', rule: 'kickRepeats * kickDistance', unit: '米' },
    },
    freeRepeats: { source: { kind: 'template_default', default: 6, unit: 'reps' } },
    auxTotalMeters: {
      source: { kind: 'derived', from: 'freeRepeats', rule: 'freeRepeats * 100', unit: '米' },
    },
    cooldownMeters: { source: { kind: 'llm_choice', min: 100, max: 200, default: 200, unit: '米' } },
    easyPaceCap: { source: { kind: 'athlete_profile', path: 'athleteProfile.swimming.easyPaceSecPer100m', unit: 's/100m' } },
    aerobicHrCap: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.aerobicRange', unit: 'bpm' } },
  },
  progression: PROG_LOW,
};

// ---------------------------------------------------------------------------
// swim.open_water.v1 — 公开水域专项
// 默认总量 1500-3000 米，或 30-60 分钟（采用时长口径，因 GPS 不稳定）。
// ---------------------------------------------------------------------------
const swimOpenWater: WorkoutTemplate = {
  id: 'swim.open_water.v1',
  fixed: {
    sport: 'swimming',
    workoutType: 'open_water',
    title: '公开水域专项',
    purpose: '练习连续游、抬头定位、转向和节奏稳定。',
    intensity: 'medium',
    stress: 'medium',
    primaryMetric: 'heart_rate',
    allowedMetrics: ['heart_rate', 'pace'],
    phases: [
      { name: 'warmup', label: '热身', duration: '$warmupDuration', description: '轻松游。' },
      { name: 'main', label: '主训练', duration: '$mainDurationTotal', description: '$continuousBlocks x $blockDuration 分钟连续游，每 $sightingFrequency 次划水做一次 sighting，组间轻松 $recoveryDuration 分钟。' },
      { name: 'cooldown', label: '放松', duration: '$cooldownDuration' },
    ],
    contraindications: ['confidence.low'],
    downgradeTo: 'swim.endurance.v1',
    requiredRecoveryHoursAfter: 24,
    minDurationMinutes: 30,
    maxDurationMinutes: 60,
    notes: '没有安全水域或陪同/安全保障时禁用。降级为泳池 swim.endurance.v1，每 4 x 50 米加一次抬头定位。',
  },
  variables: {
    totalDurationMinutes: { source: { kind: 'llm_choice', min: 30, max: 60, default: 45, unit: 'minutes' } },
    warmupDuration: { source: { kind: 'llm_choice', min: 5, max: 10, default: 8, unit: 'minutes' } },
    continuousBlocks: { source: { kind: 'template_default', default: 3, unit: 'reps' } },
    blockDuration: { source: { kind: 'llm_choice', min: 8, max: 12, default: 10, unit: 'minutes' } },
    sightingFrequency: {
      source: { kind: 'llm_choice', min: 6, max: 10, default: 8, unit: 'strokes' },
      description: '每 N 次划水做一次抬头定位。',
    },
    recoveryDuration: { source: { kind: 'template_default', default: 2, unit: 'minutes' } },
    cooldownDuration: { source: { kind: 'template_default', default: 5, unit: 'minutes' } },
    mainDurationTotal: {
      source: { kind: 'derived', from: 'continuousBlocks,blockDuration,recoveryDuration', rule: 'continuousBlocks * blockDuration + (continuousBlocks - 1) * recoveryDuration', unit: 'minutes' },
    },
    targetPace: {
      source: { kind: 'athlete_profile', path: 'athleteProfile.swimming.endurancePaceSecPer100m', optional: true, unit: 's/100m' },
      description: '公开水域 GPS 不稳定时可写 不适用。',
    },
    targetHeartRate: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.aerobicRange', unit: 'bpm' } },
  },
  progression: {
    conservative: { durationMultiplier: 0.8, repeatDelta: -1 },
    normal: { durationMultiplier: 1.0, repeatDelta: 0 },
    aggressive: { durationMultiplier: 1.1, repeatDelta: 0 },
  },
};

export const SWIMMING_TEMPLATES: Record<string, WorkoutTemplate> = {
  [swimRecovery.id]: swimRecovery,
  [swimTechnique.id]: swimTechnique,
  [swimAerobic.id]: swimAerobic,
  [swimEndurance.id]: swimEndurance,
  [swimCssThreshold.id]: swimCssThreshold,
  [swimVo2max.id]: swimVo2max,
  [swimSprint.id]: swimSprint,
  [swimPull.id]: swimPull,
  [swimKick.id]: swimKick,
  [swimOpenWater.id]: swimOpenWater,
};
