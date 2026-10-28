// Plan validation rules (U7).
//
// Translated from cofounder spec lines ~1364-1382 (校验规则). Returns an
// array of violations the caller can decide how to handle. The orchestrator
// uses violations to trigger a single retry-with-downgrade pass.

import type { ParameterizedWorkout } from './parameterizer.js';
import { MAX_WEEKLY_TRAINING_MINUTES, type ScheduleEntry } from './scheduler.js';
import type { CapacityLevel, CapacitySport, TrainingCapacity } from './training-capacity.js';
import { isNotApplicableSentinel, mentionsNotApplicable } from './not-applicable.js';

export interface PlanForValidation {
  schedule: ScheduleEntry[];
  workouts: ParameterizedWorkout[];
  context: {
    maxHardSessionsPerWeek: number;
    hardSessionsAlreadyDoneThisWeek: number;
    latestStimulus: string;
    hoursSinceLatest: number;
    fatigue: string;
    forceRequestedSchedule?: boolean;
    weeklyMaxMinutes?: number | null;
    trainingCapacity?: TrainingCapacity;
  };
}

export interface Violation {
  rule: string;
  dayIndex?: number;
  details: string;
}

const HARD_STIMULI: ReadonlySet<string> = new Set(['threshold', 'vo2max', 'anaerobic']);
const HIGH_WORKOUT_TYPES = new Set([
  'threshold',
  'css_threshold',
  'vo2max',
  'interval',
  'reverse_pyramid',
  'anaerobic',
  'sprint',
  'hill',
  'race_pace',
  'double_threshold',
  'over_under',
]);
const LOW_WORKOUT_TYPES = new Set([
  'recovery',
  'recovery_spin',
  'aerobic',
  'lsd',
  'long_ride',
  'endurance',
  'technique',
  'cadence_drill',
  'kick',
  'full_rest',
  'mobility',
  'walk',
]);
const LONG_WORKOUT_TYPES = new Set(['lsd', 'long_ride']);

export function validatePlan(plan: PlanForValidation): Violation[] {
  const violations: Violation[] = [];

  // week_coverage
  const coveredDays = new Set(plan.schedule.map((s) => s.dayIndex));
  if (coveredDays.size !== 7 || plan.workouts.length !== plan.schedule.length) {
    violations.push({
      rule: 'week_coverage',
      details: `coveredDays=${coveredDays.size}, schedule.length=${plan.schedule.length}, workouts.length=${plan.workouts.length}; expected 7 covered days with a 1:1 workout/schedule mapping.`,
    });
    // Don't bail — still try to validate what we have.
  }

  for (let i = 0; i < Math.min(plan.workouts.length, plan.schedule.length); i += 1) {
    const w = plan.workouts[i];
    const s = plan.schedule[i];
    const dayIndex = s?.dayIndex ?? i + 1;

    // template_id_present
    if (!w.templateId || w.templateId.length === 0) {
      violations.push({
        rule: 'template_id_present',
        dayIndex,
        details: `Day ${dayIndex} is missing a templateId.`,
      });
    }

    // sport_consistency
    if (w.sport !== s.sport) {
      violations.push({
        rule: 'sport_consistency',
        dayIndex,
        details: `Day ${dayIndex}: schedule.sport=${s.sport} does not match workout.sport=${w.sport}.`,
      });
    }

    // Rest-tier templates use either 'rest' (full rest) or 'mobility' (active
    // recovery walk/stretch). Both are exempt from the metric-presence rule
    // since 'targetHeartRate' may legitimately be 'N/A' when the user has
    // no HR data — these days exist precisely to NOT prescribe load.
    const isRest = s.sport === 'rest' || s.sport === 'mobility';

    if (!isRest) {
      // non_rest_must_have_metric
      if (isNotApplicableSentinel(w.targetHeartRate) && isNotApplicableSentinel(w.targetPace) && isNotApplicableSentinel(w.targetPower)) {
        violations.push({
          rule: 'non_rest_must_have_metric',
          dayIndex,
          details: `Day ${dayIndex} is a training day but targetHeartRate / targetPace / targetPower are all N/A.`,
        });
      }

      // pace_format
      if (w.sport === 'running' && !isNotApplicableSentinel(w.targetPace) && !w.targetPace.includes('/km')) {
        violations.push({
          rule: 'pace_format',
          dayIndex,
          details: `Day ${dayIndex} is a run but targetPace="${w.targetPace}" is missing /km.`,
        });
      }
      if (w.sport === 'swimming' && !isNotApplicableSentinel(w.targetPace) && !w.targetPace.includes('/100m')) {
        violations.push({
          rule: 'pace_format',
          dayIndex,
          details: `Day ${dayIndex} is a swim but targetPace="${w.targetPace}" is missing /100m.`,
        });
      }
      if (w.sport === 'cycling' && !isNotApplicableSentinel(w.targetPace)) {
        violations.push({
          rule: 'pace_format',
          dayIndex,
          details: `Day ${dayIndex} is a ride, so targetPace must be N/A; got "${w.targetPace}".`,
        });
      }

      // hr_format
      if (!isNotApplicableSentinel(w.targetHeartRate) && !w.targetHeartRate.includes('bpm')) {
        violations.push({
          rule: 'hr_format',
          dayIndex,
          details: `Day ${dayIndex}: targetHeartRate="${w.targetHeartRate}" is missing the bpm unit.`,
        });
      }

      // workout_structure_has_numbers
      if (!w.workoutStructure || !/\d/.test(w.workoutStructure)) {
        violations.push({
          rule: 'workout_structure_has_numbers',
          dayIndex,
          details: `Day ${dayIndex}: workoutStructure has no numeric detail.`,
        });
      }

      // targets_have_numbers
      for (const t of w.targets ?? []) {
        if (!/\d/.test(t) && !mentionsNotApplicable(t)) {
          violations.push({
            rule: 'targets_have_numbers',
            dayIndex,
            details: `Day ${dayIndex}: target without a number: "${t}".`,
          });
          break;
        }
      }

      const segmentDetails = validateSegmentedWorkout(w);
      if (segmentDetails) {
        violations.push({
          rule: 'segmented_workout_targets',
          dayIndex,
          details: segmentDetails,
        });
      }

      if (
        typeof s.durationCapMinutes === 'number' &&
        Number.isFinite(s.durationCapMinutes) &&
        s.durationCapMinutes > 0 &&
        w.durationMinutes > s.durationCapMinutes + 1
      ) {
        violations.push({
          rule: 'single_session_duration_within_capacity',
          dayIndex,
          details: `Day ${dayIndex}: duration ${w.durationMinutes} min > capacity cap ${s.durationCapMinutes} min (${s.durationCapReason ?? 'capacity protection'}).`,
        });
      }

      if (
        plan.context.forceRequestedSchedule !== true &&
        plan.context.trainingCapacity &&
        isCapacitySport(w.sport) &&
        plan.context.trainingCapacity.sports[w.sport].confidence === 'low' &&
        isHighWorkoutType(w.workoutType)
      ) {
        violations.push({
          rule: 'anchor_confidence_allows_precision',
          dayIndex,
          details: `Day ${dayIndex} is a high-intensity ${w.workoutType} session, but there is not enough reliable recent ${sportLabel(w.sport)} data to prescribe precise threshold/VO2/interval work.`,
        });
      }
    }
  }

  // no_consecutive_hard_days. Multiple sessions on the same day are allowed
  // only when explicitly scheduled as separate slots, so they count as one
  // hard day for spacing/budget checks.
  const hardDayIndexes = new Set<number>();
  for (let i = 0; i < plan.workouts.length; i += 1) {
    if (plan.workouts[i].intensity === 'high') {
      hardDayIndexes.add(plan.schedule[i]?.dayIndex ?? i + 1);
    }
  }
  const hardDays = Array.from(hardDayIndexes).sort((a, b) => a - b);
  if (plan.context.forceRequestedSchedule !== true) {
    for (let i = 1; i < hardDays.length; i += 1) {
      if (
        hardDays[i] === hardDays[i - 1] + 1
      ) {
        violations.push({
          rule: 'no_consecutive_hard_days',
          dayIndex: hardDays[i],
          details: `Days ${hardDays[i - 1]} and ${hardDays[i]} are back-to-back high-intensity sessions.`,
        });
      }
    }
  }

  // hard_cap_per_week
  const hardCount = hardDays.length;
  const hardBudget =
    plan.context.maxHardSessionsPerWeek -
    plan.context.hardSessionsAlreadyDoneThisWeek;
  if (plan.context.forceRequestedSchedule !== true && hardCount > Math.max(0, hardBudget)) {
    violations.push({
      rule: 'hard_cap_per_week',
      details: `High-intensity sessions this week ${hardCount} > remaining budget ${Math.max(0, hardBudget)} (cap=${plan.context.maxHardSessionsPerWeek}, done=${plan.context.hardSessionsAlreadyDoneThisWeek}).`,
    });
  }

  if (
    plan.context.forceRequestedSchedule !== true &&
    plan.context.trainingCapacity &&
    !plan.context.trainingCapacity.guardrails.allowHighIntensity &&
    hardCount > 0
  ) {
    violations.push({
      rule: 'readiness_allows_intensity',
      details: `Capacity/recovery readiness is ${plan.context.trainingCapacity.overall.readiness}, so no high-intensity sessions are allowed this week, but the plan has ${hardCount} hard days.`,
    });
  }

  if (plan.context.trainingCapacity && plan.context.forceRequestedSchedule !== true) {
    violations.push(...validateIntensityDistribution(plan));
    violations.push(...validateLongSessionShare(plan));
  }

  // recent_high_stim_cooldown
  if (
    plan.context.forceRequestedSchedule !== true &&
    HARD_STIMULI.has(plan.context.latestStimulus) &&
    plan.context.hoursSinceLatest < 24 &&
    plan.workouts.length >= 1 &&
    plan.workouts[0].intensity === 'high'
  ) {
    violations.push({
      rule: 'recent_high_stim_cooldown',
      dayIndex: 1,
      details: `A ${plan.context.latestStimulus} stimulus occurred in the last 24 h, but day 1 is still high intensity.`,
    });
  }

  const weeklyMaxMinutes = plan.context.weeklyMaxMinutes ?? MAX_WEEKLY_TRAINING_MINUTES;
  const activeMinutes = sumActiveTrainingMinutes(plan);
  if (activeMinutes > weeklyMaxMinutes + 1) {
    const longest = findLongestActiveWorkout(plan);
    violations.push({
      rule: 'weekly_duration_within_user_limit',
      dayIndex: longest?.dayIndex,
      details: `Weekly training time ${activeMinutes} min > weekly limit ${weeklyMaxMinutes} min.`,
    });
  }

  return violations;
}

function validateSegmentedWorkout(w: ParameterizedWorkout): string | null {
  const structure = w.workoutStructure ?? '';
  const targetPace = w.targetPace ?? '';
  const targetPower = w.targetPower ?? '';
  const type = w.workoutType;

  if (type === 'reverse_pyramid') {
    const hasDistances = /1200/.test(structure) && /800/.test(structure) && /400/.test(structure);
    const paces = uniqueMatches(`${targetPace}\n${structure}`, /\d+:\d{2}\s*\/km/g);
    if (!hasDistances || paces.length < 3) {
      return `Reverse pyramid must spell out the 1200/800/400 reps with three distinct target paces; current targetPace="${targetPace}".`;
    }
  }

  if (type === 'progression') {
    const hasSegments = /第一段|Segment 1/i.test(structure) && /第二段|Segment 2/i.test(structure) && /第三段|Segment 3/i.test(structure);
    const paces = uniqueMatches(`${targetPace}\n${structure}`, /\d+:\d{2}\s*\/km/g);
    if (!hasSegments || paces.length < 2) {
      return `Progression run must spell out at least three segments with increasing pace; current targetPace="${targetPace}".`;
    }
  }

  if (type === 'over_under') {
    const powers = uniqueMatches(`${targetPower}\n${structure}`, /\d+\s*W/gi);
    const hasPctPattern = /95\s*%/.test(structure) && /105\s*%/.test(structure);
    if (powers.length < 2 && !hasPctPattern) {
      return `Over-under must spell out both under and over power targets; current targetPower="${targetPower}".`;
    }
  }

  if (w.templateId === 'swim.sprint.v1') {
    const hasMain = /x|×/.test(structure) && /米|\d\s*m\b/.test(structure);
    const hasAux = /辅助|技术游|轻松|aux|technique|drill|easy/i.test(structure);
    if (!hasMain || !hasAux) {
      return 'Sprint swim must spell out the sprint main set, rest between reps, and the easy technique aux set.';
    }
  }

  return null;
}

function uniqueMatches(text: string, pattern: RegExp): string[] {
  return Array.from(new Set((text.match(pattern) ?? []).map((s) => s.replace(/\s+/g, ''))));
}

function sumActiveTrainingMinutes(plan: PlanForValidation): number {
  let total = 0;
  for (let i = 0; i < Math.min(plan.workouts.length, plan.schedule.length); i += 1) {
    const s = plan.schedule[i];
    if (s.sport === 'rest' || s.sport === 'mobility') continue;
    const minutes = Number(plan.workouts[i].durationMinutes);
    if (Number.isFinite(minutes) && minutes > 0) total += minutes;
  }
  return total;
}

function findLongestActiveWorkout(
  plan: PlanForValidation,
): { dayIndex: number; minutes: number } | null {
  let longest: { dayIndex: number; minutes: number } | null = null;
  for (let i = 0; i < Math.min(plan.workouts.length, plan.schedule.length); i += 1) {
    const s = plan.schedule[i];
    if (s.sport === 'rest' || s.sport === 'mobility') continue;
    const minutes = Number(plan.workouts[i].durationMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) continue;
    if (!longest || minutes > longest.minutes) {
      longest = { dayIndex: s.dayIndex, minutes };
    }
  }
  return longest;
}

function validateIntensityDistribution(plan: PlanForValidation): Violation[] {
  const capacity = plan.context.trainingCapacity;
  if (!capacity) return [];

  let totalMinutes = 0;
  let lowMinutes = 0;
  let highMinutes = 0;
  let longestHigh: { dayIndex: number; minutes: number } | null = null;
  let longestModerate: { dayIndex: number; minutes: number } | null = null;

  for (let i = 0; i < Math.min(plan.workouts.length, plan.schedule.length); i += 1) {
    const w = plan.workouts[i];
    const s = plan.schedule[i];
    if (s.sport === 'rest' || s.sport === 'mobility') continue;
    const minutes = Number(w.durationMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) continue;
    totalMinutes += minutes;

    const zone = intensityZone(w.workoutType, w.intensity);
    if (zone === 'low') {
      lowMinutes += minutes;
    } else if (zone === 'high') {
      highMinutes += minutes;
      if (!longestHigh || minutes > longestHigh.minutes) {
        longestHigh = { dayIndex: s.dayIndex, minutes };
      }
    } else if (!longestModerate || minutes > longestModerate.minutes) {
      longestModerate = { dayIndex: s.dayIndex, minutes };
    }
  }

  if (totalMinutes < 60) return [];

  const violations: Violation[] = [];
  const highShare = highMinutes / totalMinutes;
  const highLimit = capacity.guardrails.maxHighMinutesShare;
  if (highShare > highLimit + 0.01 && longestHigh) {
    violations.push({
      rule: 'intensity_distribution_within_week',
      dayIndex: longestHigh.dayIndex,
      details: `High-intensity share of weekly minutes ${formatPct(highShare)} > capacity limit ${formatPct(highLimit)}; downgrade the longest hard session first.`,
    });
  }

  const lowShare = lowMinutes / totalMinutes;
  const lowFloor = capacity.guardrails.minLowMinutesShare;
  if (totalMinutes >= 120 && lowShare < lowFloor - 0.1 && longestModerate) {
    violations.push({
      rule: 'low_intensity_floor_within_week',
      dayIndex: longestModerate.dayIndex,
      details: `Low-intensity share of weekly minutes ${formatPct(lowShare)} is well below the target ${formatPct(lowFloor)}; change one moderate session to an aerobic/technique session.`,
    });
  }

  return violations;
}

function validateLongSessionShare(plan: PlanForValidation): Violation[] {
  const capacity = plan.context.trainingCapacity;
  if (!capacity) return [];

  const sportTotals = new Map<CapacitySport, { minutes: number; sessions: number }>();
  for (let i = 0; i < Math.min(plan.workouts.length, plan.schedule.length); i += 1) {
    const w = plan.workouts[i];
    if (!isCapacitySport(w.sport)) continue;
    const minutes = Number(w.durationMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) continue;
    const current = sportTotals.get(w.sport) ?? { minutes: 0, sessions: 0 };
    current.minutes += minutes;
    current.sessions += 1;
    sportTotals.set(w.sport, current);
  }

  const violations: Violation[] = [];
  for (let i = 0; i < Math.min(plan.workouts.length, plan.schedule.length); i += 1) {
    const w = plan.workouts[i];
    const s = plan.schedule[i];
    if (!isCapacitySport(w.sport)) continue;
    if (!LONG_WORKOUT_TYPES.has(w.workoutType)) continue;
    const total = sportTotals.get(w.sport);
    if (!total || total.sessions < 3 || total.minutes <= 0) continue;
    const shareCap = longSessionShareCap(w.sport, capacity.overall.level);
    const share = w.durationMinutes / total.minutes;
    if (share > shareCap + 0.02) {
      violations.push({
        rule: 'long_session_share_within_capacity',
        dayIndex: s.dayIndex,
        details: `Day ${s.dayIndex}: the long session is ${formatPct(share)} of weekly ${sportLabel(w.sport)} minutes, above the ${formatPct(shareCap)} cap; shorten it or add easy base sessions.`,
      });
    }
  }
  return violations;
}

function intensityZone(
  workoutType: string,
  fallback: ParameterizedWorkout['intensity'],
): 'low' | 'moderate' | 'high' {
  if (HIGH_WORKOUT_TYPES.has(workoutType)) return 'high';
  if (LOW_WORKOUT_TYPES.has(workoutType)) return 'low';
  if (fallback === 'high') return 'high';
  if (fallback === 'low') return 'low';
  return 'moderate';
}

function isHighWorkoutType(workoutType: string): boolean {
  return HIGH_WORKOUT_TYPES.has(workoutType);
}

function longSessionShareCap(sport: CapacitySport, level: CapacityLevel): number {
  if (sport === 'running') {
    if (level === 'novice') return 0.3;
    if (level === 'developing') return 0.35;
    if (level === 'trained') return 0.4;
    return 0.45;
  }
  if (sport === 'cycling') {
    if (level === 'novice') return 0.35;
    if (level === 'developing') return 0.45;
    if (level === 'trained') return 0.5;
    return 0.55;
  }
  return 0.4;
}

function isCapacitySport(sport: string): sport is CapacitySport {
  return sport === 'running' || sport === 'cycling' || sport === 'swimming';
}

function sportLabel(sport: CapacitySport): string {
  if (sport === 'running') return 'running';
  if (sport === 'cycling') return 'cycling';
  return 'swimming';
}

function formatPct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
