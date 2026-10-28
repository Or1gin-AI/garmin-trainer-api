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
    title: 'Rest Day',
    purpose: 'Full recovery; clear fatigue before the next quality session.',
    intensity: 'low',
    stress: 'low',
    primaryMetric: 'none',
    allowedMetrics: ['none'],
    phases: [
      { name: 'aux', label: 'Rest Day', duration: '0', description: 'No structured training; light self-massage, hydration and good sleep are fine.' },
    ],
    contraindications: [],
    downgradeTo: null,
    requiredRecoveryHoursAfter: 0,
    minDurationMinutes: 0,
    maxDurationMinutes: 0,
    notes: 'Final fallback when every other option is blocked.',
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
    title: 'Mobility & Recovery',
    purpose: 'Low-stress mobility work to promote recovery.',
    intensity: 'low',
    stress: 'low',
    primaryMetric: 'heart_rate',
    allowedMetrics: ['heart_rate', 'none'],
    phases: [
      { name: 'main', label: 'Mobility / stretching', duration: '$mainDuration', description: 'Dynamic stretching, yoga or foam rolling; heart rate no higher than HR.recovery.high.' },
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
      description: 'Use the top of HR.recovery as the protective cap.',
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
    title: 'Brisk Walk',
    purpose: 'Active recovery to promote circulation.',
    intensity: 'low',
    stress: 'low',
    primaryMetric: 'heart_rate',
    allowedMetrics: ['heart_rate', 'none'],
    phases: [
      { name: 'main', label: 'Walk', duration: '$mainDuration', description: 'Steady walking with heart rate in HR.recovery; conversational effort.' },
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
