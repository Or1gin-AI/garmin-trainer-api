// Rest / recovery templates (U5).
//
// Three universal fall-back templates that the scheduler can always pick:
//   - rest.full.v1     完全休息
//   - rest.mobility.v1 活动恢复 (15-20 分钟拉伸/活动度)
//   - rest.walk.v1     步行 (20-30 分钟)
//
// They have NO contraindications by design — they exist precisely to be the
// safe terminal downgrade target when other templates get blocked.

import type { WorkoutTemplate } from './types.js';

const restFull: WorkoutTemplate = {
  id: 'rest.full.v1',
  fixed: {
    sport: 'rest',
    workoutType: 'full_rest',
    title: '完全休息',
    purpose: '完全恢复，下一个高质量训练前清空疲劳。',
    intensity: 'low',
    stress: 'low',
    primaryMetric: 'none',
    allowedMetrics: ['none'],
    phases: [
      { name: 'aux', label: '完全休息', duration: '0', description: '不安排任何主动训练；可做轻量自我按摩、补水和睡眠管理。' },
    ],
    contraindications: [],
    downgradeTo: null,
    requiredRecoveryHoursAfter: 0,
    minDurationMinutes: 0,
    maxDurationMinutes: 0,
    notes: '所有阻塞条件触发时的最终降级目标。',
  },
  variables: {},
  progression: {
    conservative: { durationMultiplier: 1.0, repeatDelta: 0 },
    normal: { durationMultiplier: 1.0, repeatDelta: 0 },
    aggressive: { durationMultiplier: 1.0, repeatDelta: 0 },
  },
};

const restMobility: WorkoutTemplate = {
  id: 'rest.mobility.v1',
  fixed: {
    sport: 'mobility',
    workoutType: 'mobility',
    title: '活动恢复',
    purpose: '低压力活动度训练，促进恢复。',
    intensity: 'low',
    stress: 'low',
    primaryMetric: 'heart_rate',
    allowedMetrics: ['heart_rate', 'none'],
    phases: [
      { name: 'main', label: '活动度 / 拉伸', duration: '$mainDuration', description: '动态拉伸、瑜伽或泡沫轴，心率不超过 HR.recovery.high。' },
    ],
    contraindications: [],
    downgradeTo: 'rest.full.v1',
    requiredRecoveryHoursAfter: 0,
    minDurationMinutes: 15,
    maxDurationMinutes: 20,
  },
  variables: {
    mainDuration: { source: { kind: 'llm_choice', min: 15, max: 20, default: 15, unit: 'minutes' } },
    targetHeartRateCap: {
      source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.recoveryRange', unit: 'bpm' },
      description: '取 HR.recovery 的上沿作为保护上限。',
    },
  },
  progression: {
    conservative: { durationMultiplier: 1.0, repeatDelta: 0 },
    normal: { durationMultiplier: 1.0, repeatDelta: 0 },
    aggressive: { durationMultiplier: 1.0, repeatDelta: 0 },
  },
};

const restWalk: WorkoutTemplate = {
  id: 'rest.walk.v1',
  fixed: {
    sport: 'mobility',
    workoutType: 'walk',
    title: '快走 / 步行',
    purpose: '主动恢复，促进血液循环。',
    intensity: 'low',
    stress: 'low',
    primaryMetric: 'heart_rate',
    allowedMetrics: ['heart_rate', 'none'],
    phases: [
      { name: 'main', label: '步行', duration: '$mainDuration', description: '稳定步行，心率保持在 HR.recovery，谈话不费力。' },
    ],
    contraindications: [],
    downgradeTo: 'rest.full.v1',
    requiredRecoveryHoursAfter: 0,
    minDurationMinutes: 20,
    maxDurationMinutes: 30,
  },
  variables: {
    mainDuration: { source: { kind: 'llm_choice', min: 20, max: 30, default: 25, unit: 'minutes' } },
    targetHeartRate: { source: { kind: 'athlete_profile', path: 'athleteProfile.heartRate.recoveryRange', unit: 'bpm' } },
  },
  progression: {
    conservative: { durationMultiplier: 1.0, repeatDelta: 0 },
    normal: { durationMultiplier: 1.0, repeatDelta: 0 },
    aggressive: { durationMultiplier: 1.0, repeatDelta: 0 },
  },
};

export const REST_TEMPLATES: Record<string, WorkoutTemplate> = {
  [restFull.id]: restFull,
  [restMobility.id]: restMobility,
  [restWalk.id]: restWalk,
};
