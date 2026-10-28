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
    title: 'Recovery Swim',
    purpose: 'Recovery and maintaining feel for the water.',
    intensity: 'low',
    stress: 'low',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: 'Warm-up', duration: '$warmupMeters m', description: 'Easy swimming.' },
      { name: 'drill', label: 'Drills', duration: '$drillTotalMeters m', description: '$drillRepeats x $drillDistance m easy drills, $drillRest s rest between.' },
      { name: 'main', label: 'Main set', duration: '$mainTotalMeters m', description: '$mainRepeats x $mainDistance m easy swim, $restSeconds s rest between.' },
      { name: 'cooldown', label: 'Cool-down', duration: '$cooldownMeters m' },
    ],
    contraindications: [],
    downgradeTo: 'rest.mobility.v1',
    requiredRecoveryHoursAfter: 0,
    minDurationMinutes: 25,
    maxDurationMinutes: 50,
    notes: 'If fatigue is high, cut total volume to 800-1200 m.',
  },
  variables: {
    totalMeters: { source: { kind: 'llm_choice', min: 1000, max: 1800, default: 1400, unit: 'meters' } },
    warmupMeters: { source: { kind: 'template_default', default: 200, unit: 'meters' } },
    drillRepeats: { source: { kind: 'template_default', default: 6, unit: 'reps' } },
    drillDistance: { source: { kind: 'template_default', default: 50, unit: 'meters' } },
    drillRest: { source: { kind: 'template_default', default: 20, unit: 'seconds' } },
    drillTotalMeters: {
      source: { kind: 'derived', from: 'drillRepeats,drillDistance', rule: 'drillRepeats * drillDistance', unit: 'meters' },
    },
    mainRepeats: { source: { kind: 'llm_choice', min: 4, max: 6, default: 5, unit: 'reps' } },
    mainDistance: { source: { kind: 'template_default', default: 100, unit: 'meters' } },
    restSeconds: { source: { kind: 'llm_choice', min: 20, max: 30, default: 25, unit: 'seconds' } },
    mainTotalMeters: {
      source: { kind: 'derived', from: 'mainRepeats,mainDistance', rule: 'mainRepeats * mainDistance', unit: 'meters' },
    },
    cooldownMeters: { source: { kind: 'llm_choice', min: 100, max: 200, default: 200, unit: 'meters' } },
    easyPaceCap: {
      source: { kind: 'derived', from: 'athleteProfile.swimming.easyPaceSecPer100m', rule: '+5..15 s/100m (upper cap)', unit: 's/100m' },
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
    title: 'Technique Swim',
    purpose: 'Improve stroke, breathing, body position and feel for the water.',
    intensity: 'low',
    stress: 'low',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: 'Warm-up', duration: '$warmupMeters m', description: 'Easy swimming.' },
      { name: 'drill', label: 'Drills', duration: '$drillTotalMeters m', description: '$drillRepeats x $drillDistance m drills: 2 rounds each of single-arm, catch-up, side kick and breathing drills, $drillRest s rest between.' },
      { name: 'main', label: 'Main set', duration: '$mainTotalMeters m', description: '$mainRepeats x $mainDistance m easy freestyle focusing on technique, $restSeconds s rest between.' },
      { name: 'cooldown', label: 'Cool-down', duration: '$cooldownMeters m' },
    ],
    contraindications: [],
    downgradeTo: 'swim.recovery.v1',
    requiredRecoveryHoursAfter: 0,
    minDurationMinutes: 30,
    maxDurationMinutes: 55,
    notes: 'If the athlete doesn\'t know these drills, replace with 10 x 50 m easy freestyle with a technique focus.',
  },
  variables: {
    totalMeters: { source: { kind: 'llm_choice', min: 1200, max: 2000, default: 1800, unit: 'meters' } },
    warmupMeters: { source: { kind: 'template_default', default: 300, unit: 'meters' } },
    drillList: { source: { kind: 'template_default', default: 'single-arm / catch-up / side kick / breathing drills' } },
    drillRepeats: { source: { kind: 'template_default', default: 8, unit: 'reps' } },
    drillDistance: { source: { kind: 'template_default', default: 50, unit: 'meters' } },
    drillRest: { source: { kind: 'template_default', default: 20, unit: 'seconds' } },
    drillTotalMeters: {
      source: { kind: 'derived', from: 'drillRepeats,drillDistance', rule: 'drillRepeats * drillDistance', unit: 'meters' },
    },
    mainRepeats: { source: { kind: 'template_default', default: 6, unit: 'reps' } },
    mainDistance: { source: { kind: 'template_default', default: 100, unit: 'meters' } },
    restSeconds: { source: { kind: 'llm_choice', min: 20, max: 30, default: 25, unit: 'seconds' } },
    mainTotalMeters: {
      source: { kind: 'derived', from: 'mainRepeats,mainDistance', rule: 'mainRepeats * mainDistance', unit: 'meters' },
    },
    cooldownMeters: { source: { kind: 'template_default', default: 200, unit: 'meters' } },
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
    title: 'Aerobic Swim',
    purpose: 'Build swimming aerobic capacity.',
    intensity: 'low',
    stress: 'medium',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: 'Warm-up', duration: '$warmupMeters m' },
      { name: 'main', label: 'Main set', duration: '$mainTotalMeters m', description: '$aerobicRepeats x $aerobicDistance m at SWIM.aerobicPace, $restSeconds s rest between.' },
      { name: 'cooldown', label: 'Cool-down', duration: '$cooldownMeters m' },
    ],
    contraindications: ['fatigue.high_risk'],
    downgradeTo: 'swim.recovery.v1',
    requiredRecoveryHoursAfter: 0,
    minDurationMinutes: 35,
    maxDurationMinutes: 65,
    notes: 'Downgrade to 8-10 x 100 m or cut total volume by 20%.',
  },
  variables: {
    totalMeters: { source: { kind: 'llm_choice', min: 1600, max: 2600, default: 2200, unit: 'meters' } },
    warmupMeters: { source: { kind: 'template_default', default: 300, unit: 'meters' } },
    aerobicRepeats: { source: { kind: 'llm_choice', min: 6, max: 8, default: 8, unit: 'reps' } },
    aerobicDistance: { source: { kind: 'template_default', default: 200, unit: 'meters' } },
    restSeconds: { source: { kind: 'llm_choice', min: 20, max: 30, default: 25, unit: 'seconds' } },
    mainTotalMeters: {
      source: { kind: 'derived', from: 'aerobicRepeats,aerobicDistance', rule: 'aerobicRepeats * aerobicDistance', unit: 'meters' },
    },
    cooldownMeters: { source: { kind: 'template_default', default: 300, unit: 'meters' } },
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
    title: 'Endurance Swim',
    purpose: 'Build continuous swimming and long-distance durability.',
    intensity: 'low',
    stress: 'medium',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: 'Warm-up', duration: '$warmupMeters m' },
      { name: 'main', label: 'Main set', duration: '$mainTotalMeters m', description: '$enduranceRepeats x $enduranceDistance m at SWIM.endurancePace, $restSeconds s rest between.' },
      { name: 'cooldown', label: 'Cool-down', duration: '$cooldownMeters m' },
    ],
    contraindications: ['confidence.low', 'fatigue.high_risk'],
    downgradeTo: 'swim.aerobic.v1',
    requiredRecoveryHoursAfter: 24,
    minDurationMinutes: 45,
    maxDurationMinutes: 75,
    notes: 'Downgrade to 4 x 300 m or swim.aerobic.v1. Not without a solid swim base or a recent swim of 1500 m+.',
  },
  variables: {
    totalMeters: { source: { kind: 'llm_choice', min: 2200, max: 3500, default: 2500, unit: 'meters' } },
    warmupMeters: { source: { kind: 'template_default', default: 400, unit: 'meters' } },
    enduranceRepeats: { source: { kind: 'template_default', default: 3, unit: 'reps' } },
    enduranceDistance: { source: { kind: 'template_default', default: 600, unit: 'meters' } },
    restSeconds: { source: { kind: 'llm_choice', min: 45, max: 60, default: 60, unit: 'seconds' } },
    mainTotalMeters: {
      source: { kind: 'derived', from: 'enduranceRepeats,enduranceDistance', rule: 'enduranceRepeats * enduranceDistance', unit: 'meters' },
    },
    cooldownMeters: { source: { kind: 'llm_choice', min: 200, max: 300, default: 300, unit: 'meters' } },
    targetPace: { source: { kind: 'athlete_profile', path: 'athleteProfile.swimming.endurancePaceSecPer100m', unit: 's/100m' } },
    aerobicHrCap: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.aerobicRange', unit: 'bpm' } },
    minimumRecentSwimMeters: { source: { kind: 'template_default', default: 1500, unit: 'meters' }, description: 'Prerequisite: at least one recent swim of 1500 m+.' },
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
    title: 'CSS Threshold Swim',
    purpose: 'Raise CSS threshold and middle-distance speed.',
    intensity: 'high',
    stress: 'high',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: 'Warm-up', duration: '$warmupMeters m', description: 'Includes 4 x 50 m build-ups.' },
      { name: 'main', label: 'Main set', duration: '$mainTotalMeters m', description: '$cssRepeats x $cssDistance m at CSS pace, $restSeconds s rest between; intermediate/advanced may use 4 x 200 m.' },
      { name: 'cooldown', label: 'Cool-down', duration: '$cooldownMeters m' },
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
    notes: 'Not without a CSS or reliable pool pace. Downgrade to swim.aerobic.v1 or 6 x 100 m.',
  },
  variables: {
    totalMeters: { source: { kind: 'llm_choice', min: 1800, max: 3000, default: 2200, unit: 'meters' } },
    warmupMeters: { source: { kind: 'template_default', default: 400, unit: 'meters' } },
    cssRepeats: { source: { kind: 'template_default', default: 8, unit: 'reps' } },
    cssDistance: { source: { kind: 'template_default', default: 100, unit: 'meters' } },
    restSeconds: { source: { kind: 'template_default', default: 20, unit: 'seconds' } },
    mainTotalMeters: {
      source: { kind: 'derived', from: 'cssRepeats,cssDistance', rule: 'cssRepeats * cssDistance', unit: 'meters' },
    },
    cooldownMeters: { source: { kind: 'llm_choice', min: 200, max: 300, default: 300, unit: 'meters' } },
    cssPace: { source: { kind: 'athlete_profile', path: 'athleteProfile.swimming.cssPaceSecPer100m', unit: 's/100m' } },
    cssPaceRange: {
      source: { kind: 'derived', from: 'athleteProfile.swimming.cssPaceSecPer100m', rule: 'cssPace to cssPace + 5 s/100m', unit: 's/100m' },
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
    title: 'VO2max Swim',
    purpose: 'Build fast repeat ability and a VO2max stimulus.',
    intensity: 'high',
    stress: 'high',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: 'Warm-up', duration: '$warmupMeters m' },
      { name: 'main', label: 'Main set', duration: '$mainTotalMeters m', description: '$vo2Repeats x $vo2Distance m at SWIM.vo2Pace, $restSeconds s rest between.' },
      { name: 'cooldown', label: 'Cool-down', duration: '$cooldownMeters m' },
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
    notes: 'Not for beginner swimmers. Downgrade to 8 x 100 m or replace with swim.css_threshold.v1.',
  },
  variables: {
    totalMeters: { source: { kind: 'llm_choice', min: 1600, max: 2600, default: 2100, unit: 'meters' } },
    warmupMeters: { source: { kind: 'template_default', default: 400, unit: 'meters' } },
    vo2Repeats: { source: { kind: 'template_default', default: 12, unit: 'reps' } },
    vo2Distance: { source: { kind: 'template_default', default: 100, unit: 'meters' } },
    restSeconds: { source: { kind: 'llm_choice', min: 30, max: 40, default: 35, unit: 'seconds' } },
    mainTotalMeters: {
      source: { kind: 'derived', from: 'vo2Repeats,vo2Distance', rule: 'vo2Repeats * vo2Distance', unit: 'meters' },
    },
    cooldownMeters: { source: { kind: 'template_default', default: 200, unit: 'meters' } },
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
    title: 'Sprint Swim',
    purpose: 'Build short-distance speed and neuromuscular recruitment.',
    intensity: 'high',
    stress: 'medium',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: 'Warm-up', duration: '$warmupMeters m', description: 'Includes 4 x 25 m build-ups.' },
      { name: 'main', label: 'Main set', duration: '$mainTotalMeters m', description: '$sprintRepeats x $sprintDistance m fast at SWIM.sprintPace, $sprintRestSeconds s rest between.' },
      { name: 'aux', label: 'Aux set', duration: '$auxTotalMeters m', description: '$easyAuxRepeats x 50 m easy technique swim, 20 s rest between.' },
      { name: 'cooldown', label: 'Cool-down', duration: '$cooldownMeters m' },
    ],
    contraindications: ['injury.shoulder', 'latestStimulus.anaerobic', 'latestStimulus.sprint'],
    downgradeTo: 'swim.aerobic.v1',
    requiredRecoveryHoursAfter: 48,
    minDurationMinutes: 30,
    maxDurationMinutes: 55,
    notes: 'Downgrade to 8-12 x 25 m.',
  },
  variables: {
    totalMeters: { source: { kind: 'llm_choice', min: 1200, max: 2200, default: 1700, unit: 'meters' } },
    warmupMeters: { source: { kind: 'template_default', default: 400, unit: 'meters' } },
    sprintRepeats: { source: { kind: 'llm_choice', min: 8, max: 16, default: 16, unit: 'reps' } },
    sprintDistance: { source: { kind: 'template_default', default: 25, unit: 'meters' } },
    sprintRestSeconds: { source: { kind: 'llm_choice', min: 30, max: 45, default: 40, unit: 'seconds' } },
    mainTotalMeters: {
      source: { kind: 'derived', from: 'sprintRepeats,sprintDistance', rule: 'sprintRepeats * sprintDistance', unit: 'meters' },
    },
    easyAuxRepeats: { source: { kind: 'template_default', default: 6, unit: 'reps' } },
    auxTotalMeters: {
      source: { kind: 'derived', from: 'easyAuxRepeats', rule: 'easyAuxRepeats * 50', unit: 'meters' },
    },
    cooldownMeters: { source: { kind: 'template_default', default: 200, unit: 'meters' } },
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
    title: 'Pull Set',
    purpose: 'Strengthen upper-body stroke efficiency and sustained pull.',
    intensity: 'low',
    stress: 'medium',
    primaryMetric: 'pace',
    allowedMetrics: ['pace', 'heart_rate'],
    phases: [
      { name: 'warmup', label: 'Warm-up', duration: '$warmupMeters m' },
      { name: 'drill', label: 'Drills', duration: '$drillTotalMeters m', description: '4 x 50 m catch-feel drills.' },
      { name: 'main', label: 'Main set', duration: '$mainTotalMeters m', description: '$pullRepeats x $pullDistance m with pull buoy (paddles optional), $restSeconds s rest between.' },
      { name: 'cooldown', label: 'Cool-down', duration: '$cooldownMeters m' },
    ],
    contraindications: ['injury.shoulder'],
    downgradeTo: 'swim.technique.v1',
    requiredRecoveryHoursAfter: 24,
    minDurationMinutes: 35,
    maxDurationMinutes: 65,
    notes: 'If paddles cause discomfort, use only the pull buoy or switch to technique swimming.',
  },
  variables: {
    totalMeters: { source: { kind: 'llm_choice', min: 1600, max: 2800, default: 2100, unit: 'meters' } },
    warmupMeters: { source: { kind: 'template_default', default: 300, unit: 'meters' } },
    drillRepeats: { source: { kind: 'template_default', default: 4, unit: 'reps' } },
    drillDistance: { source: { kind: 'template_default', default: 50, unit: 'meters' } },
    drillTotalMeters: {
      source: { kind: 'derived', from: 'drillRepeats,drillDistance', rule: 'drillRepeats * drillDistance', unit: 'meters' },
    },
    pullRepeats: { source: { kind: 'template_default', default: 8, unit: 'reps' } },
    pullDistance: { source: { kind: 'template_default', default: 100, unit: 'meters' } },
    restSeconds: { source: { kind: 'llm_choice', min: 20, max: 30, default: 25, unit: 'seconds' } },
    mainTotalMeters: {
      source: { kind: 'derived', from: 'pullRepeats,pullDistance', rule: 'pullRepeats * pullDistance', unit: 'meters' },
    },
    cooldownMeters: { source: { kind: 'template_default', default: 200, unit: 'meters' } },
    targetPace: {
      source: { kind: 'athlete_profile', path: 'athleteProfile.swimming.aerobicPaceSecPer100m', unit: 's/100m' },
      description: 'Pull sets stay aerobic by default; don\'t push pull-buoy reps toward CSS threshold.',
    },
    aerobicHrCap: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.aerobicRange', unit: 'bpm' } },
    equipment: { source: { kind: 'template_default', default: 'pull buoy + paddles (optional)' } },
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
    title: 'Kick Set',
    purpose: 'Strengthen leg propulsion and body-position control.',
    intensity: 'low',
    stress: 'low',
    primaryMetric: 'heart_rate',
    allowedMetrics: ['heart_rate', 'pace'],
    phases: [
      { name: 'warmup', label: 'Warm-up', duration: '$warmupMeters m' },
      { name: 'main', label: 'Main set', duration: '$mainTotalMeters m', description: '$kickRepeats x $kickDistance m kick, $kickRestSeconds s rest between.' },
      { name: 'aux', label: 'Aux set', duration: '$auxTotalMeters m', description: '$freeRepeats x 100 m easy freestyle, no faster than SWIM.easyPace, 20 s rest between.' },
      { name: 'cooldown', label: 'Cool-down', duration: '$cooldownMeters m' },
    ],
    contraindications: ['injury.knee', 'injury.hip'],
    downgradeTo: 'swim.technique.v1',
    requiredRecoveryHoursAfter: 0,
    minDurationMinutes: 30,
    maxDurationMinutes: 55,
    notes: 'Skip with hip/knee/ankle discomfort. Downgrade by cutting kick to 4-6 reps or doing kickboard technique work.',
  },
  variables: {
    totalMeters: { source: { kind: 'llm_choice', min: 1200, max: 2200, default: 1700, unit: 'meters' } },
    warmupMeters: { source: { kind: 'template_default', default: 300, unit: 'meters' } },
    kickRepeats: { source: { kind: 'template_default', default: 8, unit: 'reps' } },
    kickDistance: { source: { kind: 'template_default', default: 50, unit: 'meters' } },
    kickRestSeconds: { source: { kind: 'llm_choice', min: 25, max: 35, default: 30, unit: 'seconds' } },
    mainTotalMeters: {
      source: { kind: 'derived', from: 'kickRepeats,kickDistance', rule: 'kickRepeats * kickDistance', unit: 'meters' },
    },
    freeRepeats: { source: { kind: 'template_default', default: 6, unit: 'reps' } },
    auxTotalMeters: {
      source: { kind: 'derived', from: 'freeRepeats', rule: 'freeRepeats * 100', unit: 'meters' },
    },
    cooldownMeters: { source: { kind: 'llm_choice', min: 100, max: 200, default: 200, unit: 'meters' } },
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
    title: 'Open Water Swim',
    purpose: 'Practice continuous swimming, sighting, turns and steady rhythm.',
    intensity: 'low',
    stress: 'medium',
    primaryMetric: 'heart_rate',
    allowedMetrics: ['heart_rate', 'pace'],
    phases: [
      { name: 'warmup', label: 'Warm-up', duration: '$warmupDuration', description: 'Easy swimming.' },
      { name: 'main', label: 'Main set', duration: '$mainDurationTotal', description: '$continuousBlocks x $blockDuration min continuous swimming, sighting every $sightingFrequency strokes, $recoveryDuration min easy between.' },
      { name: 'cooldown', label: 'Cool-down', duration: '$cooldownDuration' },
    ],
    contraindications: ['confidence.low'],
    downgradeTo: 'swim.endurance.v1',
    requiredRecoveryHoursAfter: 24,
    minDurationMinutes: 30,
    maxDurationMinutes: 60,
    notes: 'Not without safe water and a buddy/safety cover. Downgrade to pool swim.endurance.v1 with a sighting stroke every 4 x 50 m.',
  },
  variables: {
    totalDurationMinutes: { source: { kind: 'llm_choice', min: 30, max: 60, default: 45, unit: 'minutes' } },
    warmupDuration: { source: { kind: 'llm_choice', min: 5, max: 10, default: 8, unit: 'minutes' } },
    continuousBlocks: { source: { kind: 'template_default', default: 3, unit: 'reps' } },
    blockDuration: { source: { kind: 'llm_choice', min: 8, max: 12, default: 10, unit: 'minutes' } },
    sightingFrequency: {
      source: { kind: 'llm_choice', min: 6, max: 10, default: 8, unit: 'strokes' },
      description: 'Sight once every N strokes.',
    },
    recoveryDuration: { source: { kind: 'template_default', default: 2, unit: 'minutes' } },
    cooldownDuration: { source: { kind: 'template_default', default: 5, unit: 'minutes' } },
    mainDurationTotal: {
      source: { kind: 'derived', from: 'continuousBlocks,blockDuration,recoveryDuration', rule: 'continuousBlocks * blockDuration + (continuousBlocks - 1) * recoveryDuration', unit: 'minutes' },
    },
    targetPace: {
      source: { kind: 'athlete_profile', path: 'athleteProfile.swimming.endurancePaceSecPer100m', optional: true, unit: 's/100m' },
      description: 'Use N/A when open-water GPS is unreliable.',
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
