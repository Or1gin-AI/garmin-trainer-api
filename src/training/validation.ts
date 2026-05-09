// Plan validation rules (U7).
//
// Translated from cofounder spec lines ~1364-1382 (校验规则). Returns an
// array of violations the caller can decide how to handle. The orchestrator
// uses violations to trigger a single retry-with-downgrade pass.

import type { ParameterizedWorkout } from './parameterizer.js';
import type { ScheduleEntry } from './scheduler.js';

export interface PlanForValidation {
  schedule: ScheduleEntry[];
  workouts: ParameterizedWorkout[];
  context: {
    maxHardSessionsPerWeek: number;
    hardSessionsAlreadyDoneThisWeek: number;
    latestStimulus: string;
    hoursSinceLatest: number;
    fatigue: string;
  };
}

export interface Violation {
  rule: string;
  dayIndex?: number;
  details: string;
}

const NA = '不适用';
const HARD_STIMULI: ReadonlySet<string> = new Set(['threshold', 'vo2max', 'anaerobic']);

export function validatePlan(plan: PlanForValidation): Violation[] {
  const violations: Violation[] = [];

  // length_7
  if (plan.schedule.length !== 7 || plan.workouts.length !== 7) {
    violations.push({
      rule: 'length_7',
      details: `schedule.length=${plan.schedule.length}, workouts.length=${plan.workouts.length}, 期望均为 7。`,
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
        details: `第 ${dayIndex} 天缺少 templateId。`,
      });
    }

    // sport_consistency
    if (w.sport !== s.sport) {
      violations.push({
        rule: 'sport_consistency',
        dayIndex,
        details: `第 ${dayIndex} 天 schedule.sport=${s.sport} 与 workout.sport=${w.sport} 不一致。`,
      });
    }

    const isRest = s.sport === 'rest';

    if (!isRest) {
      // non_rest_must_have_metric
      if (w.targetHeartRate === NA && w.targetPace === NA && w.targetPower === NA) {
        violations.push({
          rule: 'non_rest_must_have_metric',
          dayIndex,
          details: `第 ${dayIndex} 天为训练日但 targetHeartRate / targetPace / targetPower 均为 不适用。`,
        });
      }

      // pace_format
      if (w.sport === 'running' && w.targetPace !== NA && !w.targetPace.includes('/km')) {
        violations.push({
          rule: 'pace_format',
          dayIndex,
          details: `第 ${dayIndex} 天为跑步日，targetPace="${w.targetPace}" 缺少 /km。`,
        });
      }
      if (w.sport === 'swimming' && w.targetPace !== NA && !w.targetPace.includes('/100m')) {
        violations.push({
          rule: 'pace_format',
          dayIndex,
          details: `第 ${dayIndex} 天为游泳日，targetPace="${w.targetPace}" 缺少 /100m。`,
        });
      }
      if (w.sport === 'cycling' && w.targetPace !== NA) {
        violations.push({
          rule: 'pace_format',
          dayIndex,
          details: `第 ${dayIndex} 天为骑行日，targetPace 必须为 不适用，实际="${w.targetPace}"。`,
        });
      }

      // hr_format
      if (w.targetHeartRate !== NA && !w.targetHeartRate.includes('bpm')) {
        violations.push({
          rule: 'hr_format',
          dayIndex,
          details: `第 ${dayIndex} 天 targetHeartRate="${w.targetHeartRate}" 缺少 bpm 单位。`,
        });
      }

      // workout_structure_has_numbers
      if (!w.workoutStructure || !/\d/.test(w.workoutStructure)) {
        violations.push({
          rule: 'workout_structure_has_numbers',
          dayIndex,
          details: `第 ${dayIndex} 天 workoutStructure 缺少数字描述。`,
        });
      }

      // targets_have_numbers
      for (const t of w.targets ?? []) {
        if (!/\d/.test(t) && !t.includes(NA)) {
          violations.push({
            rule: 'targets_have_numbers',
            dayIndex,
            details: `第 ${dayIndex} 天的 targets 中存在未量化项："${t}"。`,
          });
          break;
        }
      }
    }
  }

  // no_consecutive_hard_days
  for (let i = 1; i < plan.workouts.length; i += 1) {
    if (
      plan.workouts[i].intensity === 'high' &&
      plan.workouts[i - 1].intensity === 'high'
    ) {
      violations.push({
        rule: 'no_consecutive_hard_days',
        dayIndex: i + 1,
        details: `第 ${i} 天和第 ${i + 1} 天连续为高强度课。`,
      });
    }
  }

  // hard_cap_per_week
  const hardCount = plan.workouts.filter((w) => w.intensity === 'high').length;
  const hardBudget =
    plan.context.maxHardSessionsPerWeek -
    plan.context.hardSessionsAlreadyDoneThisWeek;
  if (hardCount > Math.max(0, hardBudget)) {
    violations.push({
      rule: 'hard_cap_per_week',
      details: `本周高强度课 ${hardCount} > 剩余预算 ${Math.max(0, hardBudget)}（cap=${plan.context.maxHardSessionsPerWeek}, 已完成=${plan.context.hardSessionsAlreadyDoneThisWeek}）。`,
    });
  }

  // recent_high_stim_cooldown
  if (
    HARD_STIMULI.has(plan.context.latestStimulus) &&
    plan.context.hoursSinceLatest < 24 &&
    plan.workouts.length >= 1 &&
    plan.workouts[0].intensity === 'high'
  ) {
    violations.push({
      rule: 'recent_high_stim_cooldown',
      dayIndex: 1,
      details: `最近 24 小时内有 ${plan.context.latestStimulus} 刺激，但第 1 天仍为高强度。`,
    });
  }

  return violations;
}
