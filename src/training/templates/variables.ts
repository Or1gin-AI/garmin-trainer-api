// Logical variable names referenced by templates (U5).
//
// These are LOGICAL names (HR.recovery, RUN.easyPace, ...). The actual
// resolution to numeric values happens in U7 (parameterizer.ts) via the
// athlete profile shaped by U6 (buildAthleteProfile).
//
// Path conventions for `kind: 'athlete_profile'` variable sources:
//
//   athleteProfile.heartRate.<zone>Range            -> [low, high] in bpm
//     where <zone> in: recovery | aerobicLow | aerobic | tempo | threshold | vo2Cap
//
//   athleteProfile.running.<varName>SecPerKm        -> numeric s/km
//     where <varName> in: easyPace | longPace | tempoPace | thresholdPace |
//                          intervalPace | vo2Pace | racePace
//   athleteProfile.running.confidence               -> 'low' | 'medium' | 'high'
//
//   athleteProfile.cycling.ftpWatts                 -> number | null
//   athleteProfile.cycling.<zone>HrRange            -> [low, high]
//     where <zone> in: recovery | endurance | tempo | threshold | vo2Cap
//   athleteProfile.cycling.confidence
//
//   athleteProfile.swimming.<varName>SecPer100m     -> numeric s/100m
//     where <varName> in: easyPace | aerobicPace | endurancePace |
//                          cssPace | vo2Pace | sprintPace
//   athleteProfile.swimming.confidence
//   athleteProfile.swimming.poolLengthM             -> 25 | 50 | null
//
//   athleteProfile.injuries                         -> string[] (keywords)
//   athleteProfile.experienceLevel                  -> 'beginner' | 'intermediate' | 'advanced'
//
// `recentState` (also referenced by contraindications):
//
//   recentState.latestStimulus  -> 'recovery' | 'aerobic' | 'long_endurance' |
//                                   'tempo' | 'threshold' | 'vo2max' |
//                                   'anaerobic' | 'sprint' | 'rest'
//   recentState.fatigue         -> 'normal' | 'tired' | 'high_risk'
//   recentState.hardSessionsLast7d -> number
//   recentState.lastHighIntensityHoursAgo -> number | null

import type { Intensity } from './types.js';

// ----- Logical variable name groups ---------------------------------------

export const HR_VARS = [
  'recovery',
  'aerobicLow',
  'aerobic',
  'tempo',
  'threshold',
  'vo2Cap',
] as const;

export type HrVar = (typeof HR_VARS)[number];

export const RUN_PACE_VARS = [
  'easyPace',
  'longPace',
  'tempoPace',
  'thresholdPace',
  'intervalPace',
  'vo2Pace',
  'racePace',
] as const;

export type RunPaceVar = (typeof RUN_PACE_VARS)[number];

export const BIKE_VARS = [
  'ftp',
  'recoveryHr',
  'enduranceHr',
  'tempoHr',
  'thresholdHr',
  'vo2HrCap',
] as const;

export type BikeVar = (typeof BIKE_VARS)[number];

export const SWIM_PACE_VARS = [
  'easyPace',
  'aerobicPace',
  'endurancePace',
  'cssPace',
  'vo2Pace',
  'sprintPace',
] as const;

export type SwimPaceVar = (typeof SWIM_PACE_VARS)[number];

// ----- Per-variable descriptions ------------------------------------------
// Used by LLM prompts and admin docs. Translated from the cofounder spec
// "参数变量约定" tables.

export const VARIABLE_DESCRIPTIONS: Record<string, string> = {
  // HR
  'HR.recovery': 'Recovery zone, e.g. 110-128 bpm. Source: max HR, resting HR, recent recovery-session HR.',
  'HR.aerobicLow': 'Low aerobic zone, e.g. 128-140 bpm. Source: Garmin aerobic and long sessions.',
  'HR.aerobic': 'Standard aerobic zone, e.g. 132-146 bpm. Source: steady aerobic activities in the last 28 days.',
  'HR.tempo': 'Tempo zone, e.g. 148-158 bpm. Source: tempo / upper-aerobic activities.',
  'HR.threshold': 'Threshold zone, e.g. 160-170 bpm. Source: threshold activities, lactate threshold, 20-40 min hard steady efforts.',
  'HR.vo2Cap': 'High-intensity protective cap, e.g. <176 bpm. Source: max HR or historical high-intensity HR.',

  // Run pace
  'RUN.easyPace': 'Easy run pace. Source: average pace of recent reliable aerobic runs, or thresholdPace + 50-90 s/km.',
  'RUN.longPace': 'Long-run (LSD) pace. Rule: easyPace + 10-30 s/km, used only as an upper cap.',
  'RUN.tempoPace': 'Tempo pace. Rule: thresholdPace + 15-30 s/km.',
  'RUN.thresholdPace': 'Threshold pace. Source: recent threshold ability, ±5 s/km allowed.',
  'RUN.intervalPace': 'Interval pace. Rule: thresholdPace - 15-30 s/km.',
  'RUN.vo2Pace': 'VO2max pace. Rule: thresholdPace - 25-45 s/km.',
  'RUN.racePace': 'Goal race pace. Source: derived from the athlete\'s target distance and target time.',

  // Bike
  'BIKE.ftp': 'FTP power. Source: Garmin FTP or a 20 min power estimate; null if missing.',
  'BIKE.recoveryHr': 'Recovery ride HR. Same as HR.recovery.',
  'BIKE.enduranceHr': 'Endurance ride HR. Same as HR.aerobicLow or HR.aerobic.',
  'BIKE.tempoHr': 'Tempo ride HR. Same as HR.tempo.',
  'BIKE.thresholdHr': 'Threshold ride HR. Same as HR.threshold.',
  'BIKE.vo2HrCap': 'Cycling high-intensity protective cap. Same as HR.vo2Cap.',

  // Swim pace
  'SWIM.easyPace': 'Easy swim pace. Rule: cssPace + 12-25 s/100m.',
  'SWIM.aerobicPace': 'Aerobic swim pace. Rule: cssPace + 8-18 s/100m.',
  'SWIM.endurancePace': 'Endurance-set pace. Rule: cssPace + 10-20 s/100m.',
  'SWIM.cssPace': 'CSS / threshold pace. Source: CSS test, 400/200 test or recent threshold sets.',
  'SWIM.vo2Pace': 'VO2 swim pace. Rule: cssPace - 3-8 s/100m.',
  'SWIM.sprintPace': 'Sprint pace. Rule: cssPace - 10-20 s/100m.',
};

// ----- Hard-session policy helpers ----------------------------------------
// Scheduler caps the number of high-intensity sessions per 7-day window.
// Default is 2 per the cofounder spec ("高强度课每周最多 2 次"). Users
// flagged as high-level + stable load may raise via request override.

export const HARD_SESSION_INTENSITIES: Intensity[] = ['high'];
export const DEFAULT_MAX_HARD_SESSIONS_PER_WEEK = 2;

// Minimum hours between two same-system high-intensity sessions.
// Spec: "同一运动高强度之间至少间隔 48 小时".
export const MIN_HOURS_BETWEEN_HARD_SESSIONS = 48;

// After a threshold/VO2/anaerobic session, the next 24-48 hours is reserved
// for recovery / aerobic / technique work only. We use 36 as a midpoint;
// scheduler can override per template via requiredRecoveryHoursAfter.
export const POST_HARD_QUIET_HOURS = 36;
