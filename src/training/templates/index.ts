// Workout template library entry point (U5).
//
// All templates are pure data. Helpers below are pure functions: no I/O,
// no LLM calls, no DB. Filtering takes the user's state as input arguments.

export * from './types.js';
export * from './variables.js';

import type { Sport, WorkoutTemplate, Contraindication } from './types.js';
import { RUNNING_TEMPLATES } from './running.js';
import { CYCLING_TEMPLATES } from './cycling.js';
import { SWIMMING_TEMPLATES } from './swimming.js';
import { REST_TEMPLATES } from './rest.js';
import { DEFAULT_MAX_HARD_SESSIONS_PER_WEEK } from './variables.js';

export { RUNNING_TEMPLATES, CYCLING_TEMPLATES, SWIMMING_TEMPLATES, REST_TEMPLATES };

export const WORKOUT_TEMPLATES: Record<string, WorkoutTemplate> = {
  ...RUNNING_TEMPLATES,
  ...CYCLING_TEMPLATES,
  ...SWIMMING_TEMPLATES,
  ...REST_TEMPLATES,
};

export function getTemplate(id: string): WorkoutTemplate | undefined {
  return WORKOUT_TEMPLATES[id];
}

export function listTemplatesForSport(sport: Sport): WorkoutTemplate[] {
  return Object.values(WORKOUT_TEMPLATES).filter((t) => t.fixed.sport === sport);
}

export function listAllTemplateIds(): string[] {
  return Object.keys(WORKOUT_TEMPLATES);
}

// ---------------------------------------------------------------------------
// Catalog string for LLM prompts
// ---------------------------------------------------------------------------
// Returns a 1-line-per-template catalog usable inside a system prompt. Each
// row is approximately under 30 tokens so the full library fits comfortably
// in context. Format:
//   <id> | <sport> | <intensity> | <purpose-truncated> | block:<key contraindications>

export function getCatalogForPrompt(sportFilter?: Sport[]): string {
  const filterSet = sportFilter ? new Set(sportFilter) : null;
  const lines: string[] = [];
  for (const t of Object.values(WORKOUT_TEMPLATES)) {
    if (filterSet && !filterSet.has(t.fixed.sport)) continue;
    const purpose = truncate(t.fixed.purpose, 40);
    const block = t.fixed.contraindications.length
      ? t.fixed.contraindications.slice(0, 3).join(',')
      : 'none';
    lines.push(
      `${t.id} | ${t.fixed.sport} | ${t.fixed.intensity} | ${purpose} | block:${block}`,
    );
  }
  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// ---------------------------------------------------------------------------
// filterAllowedTemplates — pre-screen for the scheduler / LLM tool-call
// ---------------------------------------------------------------------------
// Removes templates whose hard contraindications are currently active. This
// is the gatekeeper that prevents the LLM from picking a banned template.
// The scheduler may then enforce additional soft rules (recovery hours,
// multi-sport balancing) on the survivors.

export interface FilterAthleteProfile {
  injuries?: string[];
  experienceLevel?: 'beginner' | 'intermediate' | 'advanced';
  running?: { confidence?: 'low' | 'medium' | 'high' };
  cycling?: {
    confidence?: 'low' | 'medium' | 'high';
    ftpWatts?: number | null;
  };
  swimming?: { confidence?: 'low' | 'medium' | 'high' };
}

export interface FilterRecentState {
  latestStimulus?:
    | 'recovery'
    | 'aerobic'
    | 'long_endurance'
    | 'tempo'
    | 'threshold'
    | 'vo2max'
    | 'anaerobic'
    | 'sprint'
    | 'rest'
    | null;
  fatigue?: 'normal' | 'tired' | 'high_risk';
}

export interface FilterRequest {
  sports?: Partial<Record<Sport, boolean>>;
  maxHardSessionsPerWeek?: number;
}

export interface FilterArgs {
  sport: Sport;
  athleteProfile: FilterAthleteProfile;
  recentState: FilterRecentState;
  request: FilterRequest;
  hardSessionsAlreadyScheduledThisWeek: number;
}

export function filterAllowedTemplates(args: FilterArgs): WorkoutTemplate[] {
  const {
    sport,
    athleteProfile,
    recentState,
    request,
    hardSessionsAlreadyScheduledThisWeek,
  } = args;

  // Sport must be enabled in the user's request (rest/mobility always allowed).
  const sportEnabled =
    sport === 'rest' || sport === 'mobility' || request.sports?.[sport] !== false;
  if (!sportEnabled) return [];

  const maxHard = request.maxHardSessionsPerWeek ?? DEFAULT_MAX_HARD_SESSIONS_PER_WEEK;
  const hardCapReached = hardSessionsAlreadyScheduledThisWeek >= maxHard;

  const sportConfidence = getSportConfidence(athleteProfile, sport);
  const injuries = (athleteProfile.injuries ?? []).map((i) => i.toLowerCase());

  const candidates = listTemplatesForSport(sport);
  return candidates.filter((tpl) =>
    isAllowed(tpl, {
      latestStimulus: recentState.latestStimulus ?? null,
      fatigue: recentState.fatigue ?? 'normal',
      hardCapReached,
      sportConfidence,
      injuries,
      ftpAvailable:
        athleteProfile.cycling?.ftpWatts != null && athleteProfile.cycling.ftpWatts > 0,
    }),
  );
}

function getSportConfidence(
  profile: FilterAthleteProfile,
  sport: Sport,
): 'low' | 'medium' | 'high' | undefined {
  if (sport === 'running') return profile.running?.confidence;
  if (sport === 'cycling') return profile.cycling?.confidence;
  if (sport === 'swimming') return profile.swimming?.confidence;
  return undefined;
}

interface AllowContext {
  latestStimulus: FilterRecentState['latestStimulus'];
  fatigue: 'normal' | 'tired' | 'high_risk';
  hardCapReached: boolean;
  sportConfidence: 'low' | 'medium' | 'high' | undefined;
  injuries: string[];
  ftpAvailable: boolean;
}

function isAllowed(tpl: WorkoutTemplate, ctx: AllowContext): boolean {
  // FTP-required template gate: bike.sweet_spot / bike.over_under demand FTP
  // unless data confidence is high. We block them when FTP is missing AND
  // confidence is anything but 'high' — the spec's "无 FTP 且没有稳定骑行训练历史"
  // rule applies equally to "no cycling history at all" (confidence undefined).
  if (
    !ctx.ftpAvailable &&
    ctx.sportConfidence !== 'high' &&
    tpl.fixed.primaryMetric === 'power'
  ) {
    return false;
  }

  for (const c of tpl.fixed.contraindications) {
    if (matchContraindication(c, ctx)) return false;
  }
  return true;
}

function matchContraindication(c: Contraindication, ctx: AllowContext): boolean {
  if (c.startsWith('latestStimulus.')) {
    const target = c.slice('latestStimulus.'.length);
    return ctx.latestStimulus === target;
  }
  if (c === 'fatigue.tired') return ctx.fatigue === 'tired' || ctx.fatigue === 'high_risk';
  if (c === 'fatigue.high_risk') return ctx.fatigue === 'high_risk';
  if (c === 'hardSessions.atCap') return ctx.hardCapReached;
  if (c === 'confidence.low') return ctx.sportConfidence === 'low';
  if (c.startsWith('injury.')) {
    const key = c.slice('injury.'.length);
    return ctx.injuries.includes(key);
  }
  return false;
}
