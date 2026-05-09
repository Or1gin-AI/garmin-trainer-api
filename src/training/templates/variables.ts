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
  'HR.recovery': '恢复区间，例如 110-128 bpm。来源：最大心率、静息心率、最近恢复课心率。',
  'HR.aerobicLow': '低有氧区间，例如 128-140 bpm。来源：Garmin 有氧课、长距离课。',
  'HR.aerobic': '标准有氧区间，例如 132-146 bpm。来源：最近 28 天稳定有氧活动。',
  'HR.tempo': 'Tempo 区间，例如 148-158 bpm。来源：节奏/中高有氧活动。',
  'HR.threshold': '阈值区间，例如 160-170 bpm。来源：阈值活动、乳酸阈值、20-40 分钟高稳态。',
  'HR.vo2Cap': '高强度保护上限，例如 <176 bpm。来源：最大心率或历史高强度心率。',

  // Run pace
  'RUN.easyPace': '轻松跑配速。来源：近期可靠有氧跑均配，或 thresholdPace + 50-90 秒/km。',
  'RUN.longPace': 'LSD 配速。规则：easyPace + 10-30 秒/km，只作上限。',
  'RUN.tempoPace': '节奏跑配速。规则：thresholdPace + 15-30 秒/km。',
  'RUN.thresholdPace': '阈值配速。来源：近期阈值能力，允许 ±5 秒/km。',
  'RUN.intervalPace': '间歇配速。规则：thresholdPace - 15-30 秒/km。',
  'RUN.vo2Pace': 'VO2max 配速。规则：thresholdPace - 25-45 秒/km。',
  'RUN.racePace': '比赛目标配速。来源：用户目标距离和目标时间推导。',

  // Bike
  'BIKE.ftp': 'FTP 功率。来源：Garmin FTP、20 分钟功率估算；缺失则 null。',
  'BIKE.recoveryHr': '恢复骑心率。等同 HR.recovery。',
  'BIKE.enduranceHr': '耐力骑心率。等同 HR.aerobicLow 或 HR.aerobic。',
  'BIKE.tempoHr': 'Tempo 骑心率。等同 HR.tempo。',
  'BIKE.thresholdHr': '阈值骑心率。等同 HR.threshold。',
  'BIKE.vo2HrCap': '骑行高强度保护上限。等同 HR.vo2Cap。',

  // Swim pace
  'SWIM.easyPace': '轻松游配速。规则：cssPace + 12-25 秒/100m。',
  'SWIM.aerobicPace': '有氧游配速。规则：cssPace + 8-18 秒/100m。',
  'SWIM.endurancePace': '长组耐力配速。规则：cssPace + 10-20 秒/100m。',
  'SWIM.cssPace': 'CSS / 阈值配速。来源：CSS 测试、400/200 测试或近期阈值组。',
  'SWIM.vo2Pace': 'VO2 游配速。规则：cssPace - 3-8 秒/100m。',
  'SWIM.sprintPace': '短冲配速。规则：cssPace - 10-20 秒/100m。',
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
