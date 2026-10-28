// Centralizes English display names and summary builders for the `tool_event`
// SSE channel. Both the orchestrator (plan generation) and the chat route
// dispatch through these helpers so the frontend always shows consistent,
// user-facing labels — never raw tool names or arg JSON.

import type { Violation } from './validation.js';
import { isNotApplicable } from './not-applicable.js';

export const TOOL_DISPLAY: Record<string, string> = {
  // Plan-generation pseudo tools.
  load_recent_activities: 'Loading the last 56 days of Garmin China training history',
  load_athlete_profile: 'Analyzing athlete profile and recent state',
  llm_build_schedule: "Building this week's schedule",
  llm_parameterize_workout: 'Setting workout parameters',
  validate_plan: 'Checking training load',
  llm_stream_summary: 'Writing weekly summary and monitoring tips',

  // Real chat tools.
  regenerate_day: 'Regenerating workout',
  add_second_workout: 'Adding a second workout',
  update_workout_field: 'Updating workout status',
};

const SPORT_LABEL: Record<string, string> = {
  running: 'Run',
  cycling: 'Ride',
  swimming: 'Swim',
  rest: 'Rest',
  mobility: 'Mobility',
  strength: 'Strength',
};

const STATUS_LABEL: Record<string, string> = {
  completed: 'Completed',
  skipped: 'Skipped',
  planned: 'Planned',
};

export function dayDisplay(dayIndex: number, sport?: string): string {
  const dayLabel = `Day ${dayIndex}`;
  if (sport) {
    const label = SPORT_LABEL[sport] ?? sport;
    return `${dayLabel} · ${label}`;
  }
  return dayLabel;
}

export function summarizeParameterized(
  source: 'llm' | 'fallback' | 'rest',
  workout: {
    title?: string;
    durationMinutes?: number | null;
    distanceKm?: number | null;
    targetPace?: string;
    targetHeartRate?: string;
  },
): string {
  if (source === 'rest') return 'Rest day, no parameters needed';
  const parts: string[] = [];
  if (workout.title) parts.push(workout.title);
  if (workout.distanceKm != null && Number.isFinite(workout.distanceKm)) {
    parts.push(`${Number(workout.distanceKm).toFixed(1)}km`);
  } else if (workout.durationMinutes != null) {
    parts.push(`${workout.durationMinutes} min`);
  }
  if (workout.targetPace && !isNotApplicable(workout.targetPace)) {
    parts.push(workout.targetPace);
  } else if (workout.targetHeartRate && !isNotApplicable(workout.targetHeartRate)) {
    parts.push(workout.targetHeartRate);
  }
  const head = source === 'fallback' ? 'Template defaults · ' : '';
  return head + (parts.join(' · ') || 'Generated');
}

export function summarizeValidation(violations: Violation[]): string {
  if (violations.length === 0) return 'No conflicts';
  return `${violations.length} conflict${violations.length === 1 ? '' : 's'} found, auto-adjusted`;
}

export function summarizeSchedule(
  source: 'llm' | 'deterministic',
  daysCount: number,
  sportCounts: Record<string, number>,
): string {
  const parts = Object.entries(sportCounts)
    .filter(([, n]) => n > 0)
    .map(([sport, n]) => `${n} × ${SPORT_LABEL[sport] ?? sport}`)
    .join(' + ');
  const head = source === 'deterministic' ? 'Rule-based fallback · ' : '';
  return head + `${daysCount}-day schedule (${parts || 'mostly rest'})`;
}

export function summarizeRegenerateDay(dayIndex: number, sport: string): string {
  const label = SPORT_LABEL[sport] ?? sport;
  return `Generated a ${label.toLowerCase()} workout for Day ${dayIndex}`;
}

export function summarizeAddSecondWorkout(dayIndex: number, sport: string): string {
  const label = SPORT_LABEL[sport] ?? sport;
  return `Added a second ${label.toLowerCase()} workout to Day ${dayIndex}`;
}

export function summarizeUpdateStatus(value: string): string {
  return `Status set to: ${STATUS_LABEL[value] ?? value}`;
}
