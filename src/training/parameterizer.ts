// Deterministic template parameterizer (U7).
//
// Pure function: walks template.variables, resolves each variable from
// athleteProfile / template defaults / derived rules / llm_choice midpoint
// (no LLM in V1), formats display strings, and returns a ParameterizedWorkout
// suitable to persist in the workout table.
//
// The contract here is FROZEN — U9 will replace the body but must keep the
// same input/output shape so the orchestrator and routes don't change.

import type {
  WorkoutTemplate,
  TemplateVariable,
  WorkoutPhase,
  Intensity,
  PrimaryMetric,
} from './templates/types.js';
import type { AthleteProfile } from './athlete-profile.js';
import type { RecentState } from './recent-state.js';
import type { ScheduleEntry } from './scheduler.js';
import { NOT_APPLICABLE } from './not-applicable.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ParameterizedWorkout {
  templateId: string;
  sport: string;
  workoutType: string;
  title: string;
  intensity: Intensity;
  durationMinutes: number;
  distanceKm: number | null;
  targetMetric: PrimaryMetric;
  targetHeartRate: string;
  targetPace: string;
  targetPower: string;
  workoutStructure: string;
  targets: string[];
  parameterSource: {
    templateId: string;
    progression: 'conservative' | 'normal' | 'aggressive';
    replacedVariables: Record<string, string | number>;
    downgradeReason?: string;
  };
  adaptation: string;
}

export interface ParameterizeArgs {
  template: WorkoutTemplate;
  athleteProfile: AthleteProfile;
  recentState: RecentState;
  request: {
    targetMetricPreference: 'auto' | 'heart_rate' | 'pace';
    availableTime?: string;
    dailyPreferredMinutes?: number | null;
  };
  scheduleEntry: ScheduleEntry;
  progression: 'conservative' | 'normal' | 'aggressive';
}

const NA = NOT_APPLICABLE;

// Distance units/suffixes. Templates now use 'meters' / '$var m'; the legacy
// Chinese '米' is still accepted so older template data keeps working.
function isMetersUnit(unit: string | undefined): boolean {
  return unit === 'meters' || unit === 'm' || unit === '米';
}

function isMetersSuffix(suffix: string): boolean {
  return /^m\b/.test(suffix) || suffix.includes('米');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parameterizeWorkout(args: ParameterizeArgs): ParameterizedWorkout {
  const { template, athleteProfile, recentState, request, scheduleEntry, progression } = args;
  const tuning = template.progression[progression];

  // Resolve all variables once into a context map. Numeric values when known.
  const resolved = new Map<string, ResolvedValue>();
  const replaced: Record<string, string | number> = {};

  for (const [key, variable] of Object.entries(template.variables)) {
    const value = resolveVariable(key, variable, {
      template,
      athleteProfile,
      recentState,
      tuning,
      progression,
      resolved,
    });
    resolved.set(key, value);
    if (value.kind === 'unresolved') continue;
    replaced[key] = formatForReplacedRecord(value);
  }
  // Some derived variables reference targets declared later in the template
  // object, e.g. distance / targetPace duration formulas. Retry unresolved
  // derived values once after all direct profile/default values are known.
  for (const [key, variable] of Object.entries(template.variables)) {
    if (variable.source.kind !== 'derived') continue;
    if (resolved.get(key)?.kind !== 'unresolved') continue;
    const value = resolveVariable(key, variable, {
      template,
      athleteProfile,
      recentState,
      tuning,
      progression,
      resolved,
    });
    resolved.set(key, value);
    if (value.kind === 'unresolved') continue;
    replaced[key] = formatForReplacedRecord(value);
  }

  // Compute durationMinutes by summing minute-quantified phases (and minute-
  // valued variables they reference) using the resolved values.
  const computedDurationMinutes = computeDurationMinutes(template, resolved, tuning);
  const preferredDurationMinutes = applyPreferredDuration(
    template,
    computedDurationMinutes,
    request.dailyPreferredMinutes ?? null,
    scheduleEntry.durationCapMinutes ?? null,
  );
  const durationMinutes = reconcilePreferredDuration(
    template,
    resolved,
    replaced,
    computedDurationMinutes,
    preferredDurationMinutes,
  );

  // Build target strings.
  const sport = template.fixed.sport;
  const targetHeartRate = buildHeartRateString(template, resolved);
  const targetPace = buildPaceString(template, resolved, sport);
  const targetPower = buildPowerString(template, resolved, athleteProfile, sport);
  const targetMetric = decideTargetMetric(template, request.targetMetricPreference, athleteProfile);

  // Distance estimate (running LSD / aerobic) when easyPace + duration both known.
  const distanceKm = estimateDistanceKm(template, resolved, durationMinutes);

  // Workout structure (Chinese narrative).
  const workoutStructure = buildWorkoutStructure(template, resolved, {
    targetHeartRate,
    targetPace,
    targetPower,
  });

  // Targets array (bullets).
  const targets = buildTargetsArray({
    template,
    targetHeartRate,
    targetPace,
    targetPower,
    durationMinutes,
    preferredDurationMinutes: request.dailyPreferredMinutes ?? null,
    distanceKm,
    resolved,
  });

  // Adaptation.
  const adaptation = buildAdaptation(template, durationMinutes);

  // Downgrade reason (when the scheduler swapped to a downgrade target).
  const downgradeReason = inferDowngradeReason(template, scheduleEntry);

  return {
    templateId: template.id,
    sport,
    workoutType: template.fixed.workoutType,
    title: template.fixed.title,
    intensity: template.fixed.intensity,
    durationMinutes,
    distanceKm,
    targetMetric,
    targetHeartRate,
    targetPace,
    targetPower,
    workoutStructure,
    targets,
    parameterSource: {
      templateId: template.id,
      progression,
      replacedVariables: replaced,
      ...(downgradeReason ? { downgradeReason } : {}),
    },
    adaptation,
  };
}

// ---------------------------------------------------------------------------
// Variable resolution
// ---------------------------------------------------------------------------

type ResolvedValue =
  | { kind: 'unresolved' }
  | { kind: 'number'; value: number; unit?: string }
  | { kind: 'range'; low: number; high: number; unit?: string }
  | { kind: 'string'; value: string };

interface ResolveCtx {
  template: WorkoutTemplate;
  athleteProfile: AthleteProfile;
  recentState: RecentState;
  tuning: WorkoutTemplate['progression'][keyof WorkoutTemplate['progression']];
  progression: 'conservative' | 'normal' | 'aggressive';
  resolved: Map<string, ResolvedValue>;
}

function resolveVariable(
  key: string,
  variable: TemplateVariable,
  ctx: ResolveCtx,
): ResolvedValue {
  const src = variable.source;
  switch (src.kind) {
    case 'template_default': {
      if (typeof src.default === 'number') {
        let v = src.default;
        if (src.unit === 'minutes') v = v * ctx.tuning.durationMultiplier;
        return { kind: 'number', value: roundSmart(v), unit: src.unit };
      }
      return { kind: 'string', value: String(src.default) };
    }
    case 'athlete_profile': {
      const raw = lookupPath(ctx.athleteProfile, src.path);
      const formatted = coerceProfileValue(raw, src.unit, src.min, src.max);
      if (formatted.kind === 'unresolved') {
        // Fallback for minute-typed profile lookups: use the midpoint of
        // [min, max] when both are present. Lets templates like run.lsd.v1
        // (which look up athleteProfile.running.lsdMainDurationMinutes — a
        // path that buildAthleteProfile does NOT populate) still resolve to
        // a sensible duration.
        if (
          src.unit === 'minutes' &&
          typeof src.min === 'number' &&
          typeof src.max === 'number'
        ) {
          const mid = (src.min + src.max) / 2;
          return {
            kind: 'number',
            value: roundSmart(mid * ctx.tuning.durationMultiplier),
            unit: 'minutes',
          };
        }
        return { kind: 'unresolved' };
      }
      // Apply minutes multiplier when the athlete-profile path is a duration.
      if (
        src.unit === 'minutes' &&
        formatted.kind === 'number' &&
        Number.isFinite(formatted.value)
      ) {
        const adjusted = roundSmart(formatted.value * ctx.tuning.durationMultiplier);
        return { kind: 'number', value: adjusted, unit: 'minutes' };
      }
      return formatted;
    }
    case 'derived': {
      return resolveDerived(key, src.rule, src.from, src.unit, ctx);
    }
    case 'llm_choice': {
      const min = src.min ?? src.default ?? 0;
      const max = src.max ?? src.default ?? min;
      const def =
        typeof src.default === 'number' ? src.default : (min + max) / 2;
      let value = def;
      // Apply progression to repeat counts and minute-valued choices.
      if (src.unit === 'reps') {
        value = clamp(Math.round(value + ctx.tuning.repeatDelta), 1, max);
      }
      if (src.unit === 'minutes') {
        value = roundSmart(value * ctx.tuning.durationMultiplier);
      }
      return { kind: 'number', value, unit: src.unit };
    }
    default: {
      return { kind: 'unresolved' };
    }
  }
}

function lookupPath(root: AthleteProfile, path: string): unknown {
  // Path examples:
  //   athleteProfile.heartRate.aerobicRange
  //   athleteProfile.running.easyPaceSecPerKm
  //   athleteProfile.cycling.ftpWatts
  const parts = path.split('.');
  if (parts[0] === 'athleteProfile') parts.shift();
  let cur: unknown = root;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function coerceProfileValue(
  raw: unknown,
  unit: string | undefined,
  min: number | undefined,
  max: number | undefined,
): ResolvedValue {
  if (raw === undefined || raw === null) return { kind: 'unresolved' };
  if (Array.isArray(raw)) {
    if (raw.length === 2 && raw.every((v) => typeof v === 'number')) {
      return { kind: 'range', low: raw[0] as number, high: raw[1] as number, unit };
    }
    if (raw.length > 0 && raw.every((v) => typeof v === 'string')) {
      return { kind: 'string', value: (raw as string[]).join('、') };
    }
    return { kind: 'unresolved' };
  }
  if (typeof raw === 'number') {
    let v = raw;
    if (typeof min === 'number') v = Math.max(min, v);
    if (typeof max === 'number') v = Math.min(max, v);
    return { kind: 'number', value: v, unit };
  }
  if (typeof raw === 'string') return { kind: 'string', value: raw };
  if (typeof raw === 'boolean') return { kind: 'string', value: raw ? 'yes' : 'no' };
  return { kind: 'unresolved' };
}

function resolveDerived(
  key: string,
  rule: string,
  from: string,
  targetUnit: string | undefined,
  ctx: ResolveCtx,
): ResolvedValue {
  // FTP-derived percentages.
  const ftp = ctx.athleteProfile.cycling?.ftpWatts ?? null;
  const pctRange = parsePercentRange(rule);
  if (pctRange && ftp && ftp > 0) {
    return {
      kind: 'range',
      low: Math.round((ftp * pctRange.low) / 100),
      high: Math.round((ftp * pctRange.high) / 100),
      unit: 'W',
    };
  }
  // <55% / >150% must be checked before single-percent parsing, otherwise
  // caps/floors collapse into exact targets.
  const pctUpper = parsePercentUpper(rule);
  if (pctUpper && ftp && ftp > 0) {
    return {
      kind: 'number',
      value: Math.round((ftp * pctUpper.value) / 100),
      unit: 'W_upper',
    };
  }
  const pctLower = parsePercentLower(rule);
  if (pctLower && ftp && ftp > 0) {
    return {
      kind: 'number',
      value: Math.round((ftp * pctLower.value) / 100),
      unit: 'W_lower',
    };
  }
  const pctSingle = parsePercentSingle(rule);
  if (pctSingle && ftp && ftp > 0) {
    return {
      kind: 'number',
      value: Math.round((ftp * pctSingle.value) / 100),
      unit: 'W',
    };
  }

  // Pace adjustments referencing easyPace, longPace, etc.
  const paceAdj = parsePaceOffset(rule, from);
  if (paceAdj) {
    const basePath = paceAdj.basePath;
    const baseRaw = lookupPath(ctx.athleteProfile, basePath);
    if (typeof baseRaw === 'number' && Number.isFinite(baseRaw)) {
      if (paceAdj.range) {
        const low = baseRaw + paceAdj.range[0];
        const high = baseRaw + paceAdj.range[1];
        return {
          kind: 'range',
          low: Math.min(low, high),
          high: Math.max(low, high),
          unit: paceAdj.unit,
        };
      }
      return {
        kind: 'number',
        value: baseRaw + paceAdj.singleOffset,
        unit: key.endsWith('Cap') ? `${paceAdj.unit}_upper` : paceAdj.unit,
      };
    }
  }

  // mainDurationTotal / mainTotalMeters style: composed from already-resolved variables.
  const composed = composeNumberFromOtherVars(rule, ctx, targetUnit);
  if (composed) {
    return composed;
  }

  return { kind: 'unresolved' };
}

function parsePercentRange(rule: string): { low: number; high: number } | null {
  const match = rule.match(/(\d+)\s*-\s*(\d+)\s*%/);
  if (!match) return null;
  const low = Number(match[1]);
  const high = Number(match[2]);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  return { low, high };
}

function parsePercentSingle(rule: string): { value: number } | null {
  // Match a single "NN% FTP" without a preceding hyphen-range marker.
  if (/\d+\s*-\s*\d+\s*%/.test(rule)) return null;
  const match = rule.match(/(\d+)\s*%/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  return { value };
}

function parsePercentUpper(rule: string): { value: number } | null {
  const match = rule.match(/<\s*(\d+)\s*%/);
  if (!match) return null;
  return { value: Number(match[1]) };
}

function parsePercentLower(rule: string): { value: number } | null {
  const match = rule.match(/>\s*(\d+)\s*%/);
  if (!match) return null;
  return { value: Number(match[1]) };
}

interface PaceOffsetParse {
  basePath: string;
  unit: 's/km' | 's/100m';
  range: [number, number] | null;
  singleOffset: number;
}

function parsePaceOffset(rule: string, from: string): PaceOffsetParse | null {
  // Examples:
  //   '+30..+50 s/km'          -> base inferred from `from` (caller passes
  //                              athleteProfile.running.<x>SecPerKm typically)
  //   'easyPace + 10..30 s/km' -> base = athleteProfile.running.easyPaceSecPerKm
  //   'easyPace - 10..25 s/km' -> faster-than-easy progression finish
  //   'cssPace to cssPace + 5 s/100m' -> CSS threshold range (legacy: '到')
  //   '+20 s/km (upper cap, optional)'   -> singleOffset = 20
  //   '+5..15 s/100m (upper cap)'   -> swimming offset
  const baseMap: Record<string, string> = {
    easyPace: 'athleteProfile.running.easyPaceSecPerKm',
    longPace: 'athleteProfile.running.longPaceSecPerKm',
    tempoPace: 'athleteProfile.running.tempoPaceSecPerKm',
    thresholdPace: 'athleteProfile.running.thresholdPaceSecPerKm',
    intervalPace: 'athleteProfile.running.intervalPaceSecPerKm',
    vo2Pace: 'athleteProfile.running.vo2PaceSecPerKm',
    racePace: 'athleteProfile.running.racePaceSecPerKm',
    aerobicPace: 'athleteProfile.swimming.aerobicPaceSecPer100m',
    endurancePace: 'athleteProfile.swimming.endurancePaceSecPer100m',
    cssPace: 'athleteProfile.swimming.cssPaceSecPer100m',
    sprintPace: 'athleteProfile.swimming.sprintPaceSecPer100m',
  };

  const unit = rule.includes('s/100m') || from.includes('SecPer100m') ? 's/100m' : 's/km';
  let basePath: string | null = null;
  for (const [key, path] of Object.entries(baseMap)) {
    if (rule.includes(key)) {
      basePath = path;
      break;
    }
  }
  if (!basePath && from.startsWith('athleteProfile.')) {
    basePath = from;
  }
  // If no explicit base name appears, only handle offset style with an
  // inferred easy running / CSS swimming base.
  if (!basePath) {
    const offset = rule.match(/([+-])\s*(\d+)\s*s\/km/);
    if (offset) {
      return {
        basePath: 'athleteProfile.running.easyPaceSecPerKm',
        unit: 's/km',
        range: null,
        singleOffset: signedNumber(offset[1], offset[2]),
      };
    }
    const offset100 = rule.match(/([+-])\s*(\d+)\s*s\/100m/);
    if (offset100) {
      return {
        basePath: 'athleteProfile.swimming.cssPaceSecPer100m',
        unit: 's/100m',
        range: null,
        singleOffset: signedNumber(offset100[1], offset100[2]),
      };
    }
    return null;
  }

  const toRangeMatch = rule.match(
    /(\w+)\s*(?:到|to)\s*(\w+)\s*([+-])\s*(\d+)\s*s\/(km|100m)/,
  );
  const toRangeBasePath = toRangeMatch ? baseMap[toRangeMatch[1]] : null;
  const toRangeEndPath = toRangeMatch ? baseMap[toRangeMatch[2]] : null;
  if (toRangeMatch && toRangeBasePath && toRangeBasePath === toRangeEndPath) {
    return {
      basePath: toRangeBasePath,
      unit: toRangeMatch[5] === '100m' ? 's/100m' : 's/km',
      range: [0, signedNumber(toRangeMatch[3], toRangeMatch[4])],
      singleOffset: 0,
    };
  }

  const rangeMatch = rule.match(
    /([+-])?\s*(\d+)\s*\.\.+\s*([+-])?\s*(\d+)\s*s\/(km|100m)/,
  );
  if (rangeMatch) {
    const firstSign = rangeMatch[1] ?? '+';
    const secondSign = rangeMatch[3] ?? firstSign;
    return {
      basePath,
      unit: rangeMatch[5] === '100m' ? 's/100m' : unit,
      range: [signedNumber(firstSign, rangeMatch[2]), signedNumber(secondSign, rangeMatch[4])],
      singleOffset: 0,
    };
  }
  const upper = rule.match(/([+-])\s*(\d+)\s*s\/(km|100m)/);
  if (upper) {
    return {
      basePath,
      unit: upper[3] === '100m' ? 's/100m' : unit,
      range: null,
      singleOffset: signedNumber(upper[1], upper[2]),
    };
  }
  return null;
}

function signedNumber(sign: string, value: string): number {
  const n = Number(value);
  return sign === '-' ? -n : n;
}

function composeNumberFromOtherVars(
  rule: string,
  ctx: ResolveCtx,
  targetUnit: string | undefined,
): ResolvedValue | null {
  // "n * work + (n - 1) * recovery" interval-block formula.
  const intervalMinutes = rule.match(
    /(\w+)\s*\*\s*(\w+)\s*\+\s*\(\s*\1\s*-\s*1\s*\)\s*\*\s*(\w+)/,
  );
  if (intervalMinutes) {
    const reps = readNumberFromResolved(ctx.resolved.get(intervalMinutes[1]));
    const dur = readMinutesFromResolved(ctx.resolved.get(intervalMinutes[2]));
    const rec = readMinutesFromResolved(ctx.resolved.get(intervalMinutes[3]));
    if (reps !== null && dur !== null && rec !== null) {
      return { kind: 'number', value: roundSmart(reps * dur + (reps - 1) * rec), unit: 'minutes' };
    }
  }

  // "n * distance / pace + (n - 1) * recovery" race/interval formula.
  const distancePace = rule.match(
    /(\w+)\s*\*\s*(\w+)\s*\/\s*(\w+)\s*\+\s*\(\s*(\w+)\s*-\s*1\s*\)\s*\*\s*(\w+)/,
  );
  if (distancePace && (distancePace[1] === distancePace[4] || distancePace[4] === 'n')) {
    const reps = readNumberFromResolved(ctx.resolved.get(distancePace[1]));
    const distance = ctx.resolved.get(distancePace[2]);
    const pace = readPaceSeconds(ctx.resolved.get(distancePace[3]));
    const rec = readMinutesFromResolved(ctx.resolved.get(distancePace[5]));
    const workMinutes = distance && pace ? durationFromDistanceAndPace(distance, pace) : null;
    if (reps !== null && workMinutes !== null && rec !== null) {
      return { kind: 'number', value: roundSmart(reps * workMinutes + (reps - 1) * rec), unit: 'minutes' };
    }
  }

  // "n * (duration + recovery) seconds" for hill/stride blocks.
  const parenSeconds = rule.match(
    /(\w+)\s*\*\s*\(\s*(\w+)\s*\+\s*(\w+)\s*\)\s*seconds/,
  );
  if (parenSeconds) {
    const reps = readNumberFromResolved(ctx.resolved.get(parenSeconds[1]));
    const dur = readNumberFromResolved(ctx.resolved.get(parenSeconds[2]));
    const rec = readNumberFromResolved(ctx.resolved.get(parenSeconds[3]));
    if (reps !== null && dur !== null && rec !== null) {
      return { kind: 'number', value: roundSmart(reps * (dur + rec)), unit: 'seconds' };
    }
  }

  // "n * (duration + recovery) - recovery" for repeated blocks in minutes.
  const parenMinus = rule.match(
    /(\w+)\s*\*\s*\(\s*(\w+)\s*\+\s*(\w+)\s*\)\s*-\s*(\w+)/,
  );
  if (parenMinus && parenMinus[3] === parenMinus[4]) {
    const reps = readNumberFromResolved(ctx.resolved.get(parenMinus[1]));
    const dur = readMinutesFromResolved(ctx.resolved.get(parenMinus[2]));
    const rec = readMinutesFromResolved(ctx.resolved.get(parenMinus[3]));
    if (reps !== null && dur !== null && rec !== null) {
      return { kind: 'number', value: roundSmart(reps * (dur + rec) - rec), unit: 'minutes' };
    }
  }

  // "n * (seconds/60 + minutes)" for sprint blocks.
  const secondsPlusMinutes = rule.match(
    /(\w+)\s*\*\s*\(\s*(\w+)\/60\s*\+\s*(\w+)\s*\)/,
  );
  if (secondsPlusMinutes) {
    const reps = readNumberFromResolved(ctx.resolved.get(secondsPlusMinutes[1]));
    const seconds = readNumberFromResolved(ctx.resolved.get(secondsPlusMinutes[2]));
    const minutes = readMinutesFromResolved(ctx.resolved.get(secondsPlusMinutes[3]));
    if (reps !== null && seconds !== null && minutes !== null) {
      return { kind: 'number', value: roundSmart(reps * (seconds / 60 + minutes)), unit: 'minutes' };
    }
  }

  // Simple products used for swim/run distance totals: "reps * distance" or
  // "reps * 50". Only apply when the rule is exactly the product.
  const product = rule.match(/^(\w+)\s*\*\s*(\w+|\d+(?:\.\d+)?)$/);
  if (product) {
    const left = readNumberFromResolved(ctx.resolved.get(product[1]));
    const right = /^\d/.test(product[2])
      ? Number(product[2])
      : readNumberFromResolved(ctx.resolved.get(product[2]));
    if (left !== null && right !== null && Number.isFinite(right)) {
      return { kind: 'number', value: roundSmart(left * right), unit: targetUnit };
    }
  }

  return null;
}

function readNumberFromResolved(v: ResolvedValue | undefined): number | null {
  if (!v) return null;
  if (v.kind === 'number') return v.value;
  return null;
}

function readMinutesFromResolved(v: ResolvedValue | undefined): number | null {
  if (!v || v.kind !== 'number') return null;
  if (v.unit === 'seconds') return v.value / 60;
  return v.value;
}

function readPaceSeconds(v: ResolvedValue | undefined): { seconds: number; unit: 's/km' | 's/100m' } | null {
  if (!v) return null;
  if (v.kind === 'number' && (v.unit === 's/km' || v.unit === 's/100m')) {
    return { seconds: v.value, unit: v.unit };
  }
  if (v.kind === 'range' && (v.unit === 's/km' || v.unit === 's/100m')) {
    return { seconds: (v.low + v.high) / 2, unit: v.unit };
  }
  return null;
}

function durationFromDistanceAndPace(
  distance: ResolvedValue,
  pace: { seconds: number; unit: 's/km' | 's/100m' },
): number | null {
  if (distance.kind !== 'number' || !Number.isFinite(distance.value) || distance.value <= 0) {
    return null;
  }
  if (pace.seconds <= 0) return null;
  if (pace.unit === 's/km') {
    const km = isMetersUnit(distance.unit) ? distance.value / 1000 : distance.value;
    return (km * pace.seconds) / 60;
  }
  const meters = distance.unit === 'km' ? distance.value * 1000 : distance.value;
  return ((meters / 100) * pace.seconds) / 60;
}

// ---------------------------------------------------------------------------
// Display string builders
// ---------------------------------------------------------------------------

function buildHeartRateString(
  template: WorkoutTemplate,
  resolved: Map<string, ResolvedValue>,
): string {
  // LSD-style: separate low/high zone variables — prefer combining them so
  // we get a wider range than either alone.
  const low = resolved.get('targetHeartRateLow');
  const high = resolved.get('targetHeartRateHigh');
  if (
    low?.kind === 'range' &&
    high?.kind === 'range'
  ) {
    return `${Math.round(low.low)}-${Math.round(high.high)} bpm`;
  }

  const candidates = [
    'targetHeartRate',
    'targetHeartRateLow',
    'aerobicHrCap',
    'aerobicLowHrCap',
    'recoveryHr',
    'tempoHr',
    'thresholdHrLow',
    'enduranceHr',
    'vo2HrCap',
    'targetHeartRateCap',
  ];
  for (const key of candidates) {
    const v = resolved.get(key);
    if (!v) continue;
    if (v.kind === 'range') {
      return `${Math.round(v.low)}-${Math.round(v.high)} bpm`;
    }
    if (v.kind === 'number') {
      if (v.unit === 'W' || v.unit === 'W_upper' || v.unit === 'W_lower') continue;
      return `<${Math.round(v.value)} bpm`;
    }
  }
  // For some swim/non-HR templates, none of the above resolve.
  if (template.fixed.primaryMetric === 'none') return NA;
  return NA;
}

function buildPaceString(
  template: WorkoutTemplate,
  resolved: Map<string, ResolvedValue>,
  sport: string,
): string {
  if (sport === 'cycling') return NA;

  if (sport === 'running' && template.fixed.workoutType === 'reverse_pyramid') {
    const paces = [
      paceSeconds(resolved, 'pyramid1200Pace'),
      paceSeconds(resolved, 'pyramid800Pace'),
      paceSeconds(resolved, 'pyramid400Pace'),
    ].filter((v): v is number => v !== null);
    if (paces.length === 3) {
      return `${formatSeconds(Math.min(...paces))}-${formatSeconds(Math.max(...paces))}/km`;
    }
  }

  const candidates = [
    'targetPace',
    'targetPaceCap',
    'longPaceCap',
    'cssPaceRange',
    'cssPace',
    'easyPaceCap',
    'sprintPace',
    'easyPace',
    'tempoPace',
  ];
  const swimUnit = '/100m';
  const runUnit = '/km';
  const unit = sport === 'swimming' ? swimUnit : runUnit;

  for (const key of candidates) {
    const v = resolved.get(key);
    if (!v) continue;
    if (v.kind === 'range') {
      return `${formatSeconds(v.low)}-${formatSeconds(v.high)}${unit}`;
    }
    if (v.kind === 'number') {
      if (v.unit === 'W' || v.unit === 'W_upper') continue;
      const isUpperCap =
        key === 'longPaceCap' ||
        key === 'targetPaceCap' ||
        key === 'easyPaceCap';
      if (v.unit === 's/km_upper' || v.unit === 's/100m_upper' || isUpperCap) {
        return `no faster than ${formatSeconds(v.value)}${unit}`;
      }
      if (v.unit === 's/km' || v.unit === 's/100m') {
        return `${formatSeconds(v.value)}${unit}`;
      }
      if (v.unit && v.unit !== 's/km' && v.unit !== 's/100m') continue;
      return `${formatSeconds(v.value)}${unit}`;
    }
  }
  return NA;
}

function buildPowerString(
  template: WorkoutTemplate,
  resolved: Map<string, ResolvedValue>,
  athleteProfile: AthleteProfile,
  sport: string,
): string {
  if (sport !== 'cycling') return NA;
  if (!athleteProfile.cycling.ftpWatts || athleteProfile.cycling.ftpWatts <= 0) {
    return NA;
  }
  const candidates = [
    'thresholdPowerRange',
    'sweetSpotPowerRange',
    'tempoPowerRange',
    'endurancePowerRange',
    'longRidePowerRange',
    'vo2PowerRange',
    'climbPowerRange',
    'anaerobicPowerRange',
    'drillPowerRange',
    'recoveryPowerCap',
    'sprintPowerFloor',
    'underPower',
    'overPower',
  ];
  const underPower = resolved.get('underPower');
  const overPower = resolved.get('overPower');
  if (
    underPower?.kind === 'number' &&
    overPower?.kind === 'number' &&
    underPower.unit === 'W' &&
    overPower.unit === 'W'
  ) {
    const low = Math.min(underPower.value, overPower.value);
    const high = Math.max(underPower.value, overPower.value);
    return `${Math.round(low)}-${Math.round(high)} W`;
  }
  for (const key of candidates) {
    const v = resolved.get(key);
    if (!v) continue;
    if (v.kind === 'range' && v.unit === 'W') {
      return `${Math.round(v.low)}-${Math.round(v.high)} W`;
    }
    if (v.kind === 'number') {
      if (v.unit === 'W') return `${Math.round(v.value)} W`;
      if (v.unit === 'W_upper') return `<${Math.round(v.value)} W`;
      if (v.unit === 'W_lower') return `>${Math.round(v.value)} W`;
    }
  }
  return NA;
}

function decideTargetMetric(
  template: WorkoutTemplate,
  preference: 'auto' | 'heart_rate' | 'pace',
  athleteProfile: AthleteProfile,
): PrimaryMetric {
  const primary = template.fixed.primaryMetric;
  // Power required but no FTP -> downgrade to heart_rate if allowed.
  if (
    primary === 'power' &&
    (!athleteProfile.cycling.ftpWatts || athleteProfile.cycling.ftpWatts <= 0)
  ) {
    if (template.fixed.allowedMetrics.includes('heart_rate')) return 'heart_rate';
    return 'mixed';
  }
  if (preference === 'auto') return primary;
  if (preference === 'heart_rate' && template.fixed.allowedMetrics.includes('heart_rate')) {
    return 'heart_rate';
  }
  if (preference === 'pace' && template.fixed.allowedMetrics.includes('pace')) {
    return 'pace';
  }
  return primary;
}

// ---------------------------------------------------------------------------
// Duration / distance / structure / targets / adaptation
// ---------------------------------------------------------------------------

function computeDurationMinutes(
  template: WorkoutTemplate,
  resolved: Map<string, ResolvedValue>,
  tuning: WorkoutTemplate['progression'][keyof WorkoutTemplate['progression']],
): number {
  // Sum up minute-typed phase durations.
  let total = 0;
  for (const phase of template.fixed.phases) {
    const minutes = resolvePhaseMinutes(phase, resolved);
    if (minutes !== null) total += minutes;
  }
  if (total <= 0) {
    // Fallback to template min..max midpoint times multiplier.
    const mid = (template.fixed.minDurationMinutes + template.fixed.maxDurationMinutes) / 2;
    total = mid > 0 ? mid * tuning.durationMultiplier : 0;
  }
  return Math.max(0, Math.round(total));
}

function applyPreferredDuration(
  template: WorkoutTemplate,
  durationMinutes: number,
  preferredMinutes: number | null,
  capacityCapMinutes: number | null,
): number {
  if (
    template.fixed.sport === 'rest' ||
    template.fixed.sport === 'mobility' ||
    durationMinutes <= 0
  ) {
    return durationMinutes;
  }

  let resolved = durationMinutes;
  if (
    preferredMinutes !== null &&
    Number.isFinite(preferredMinutes) &&
    preferredMinutes > 0
  ) {
    // User-provided minutes are treated as an availability cap, not a target to
    // stretch every workout toward. This prevents long availability from
    // inflating threshold/VO2 sessions.
    resolved = Math.min(resolved, Math.round(preferredMinutes));
  }
  if (
    capacityCapMinutes !== null &&
    Number.isFinite(capacityCapMinutes) &&
    capacityCapMinutes > 0
  ) {
    resolved = Math.min(resolved, Math.round(capacityCapMinutes));
  }

  const lower = Math.max(15, Math.min(template.fixed.minDurationMinutes, resolved));
  const upper = Math.max(lower, template.fixed.maxDurationMinutes);
  return clamp(resolved, lower, upper);
}

function reconcilePreferredDuration(
  template: WorkoutTemplate,
  resolved: Map<string, ResolvedValue>,
  replaced: Record<string, string | number>,
  computedDurationMinutes: number,
  preferredDurationMinutes: number,
): number {
  if (
    preferredDurationMinutes === computedDurationMinutes ||
    template.fixed.sport === 'rest' ||
    template.fixed.sport === 'mobility'
  ) {
    return computedDurationMinutes;
  }

  const main = resolved.get('mainDuration');
  if (!main || main.kind !== 'number' || main.unit !== 'minutes') {
    return computedDurationMinutes;
  }

  const usesSimpleMainPhase = template.fixed.phases.some(
    (phase) => phase.name === 'main' && phase.duration?.trim() === '$mainDuration',
  );
  if (!usesSimpleMainPhase) {
    return computedDurationMinutes;
  }

  const fixedMinutes = computedDurationMinutes - main.value;
  const requestedMain = preferredDurationMinutes - fixedMinutes;
  const nextMain =
    requestedMain < 5 && preferredDurationMinutes < computedDurationMinutes
      ? 5
      : requestedMain;
  if (!Number.isFinite(nextMain) || nextMain < 5) {
    return computedDurationMinutes;
  }

  const adjustedMain = roundSmart(nextMain);
  resolved.set('mainDuration', {
    kind: 'number',
    value: adjustedMain,
    unit: 'minutes',
  });
  replaced.mainDuration = adjustedMain;
  return Math.max(0, Math.round(fixedMinutes + adjustedMain));
}

function resolvePhaseMinutes(
  phase: WorkoutPhase,
  resolved: Map<string, ResolvedValue>,
): number | null {
  if (!phase.duration) return null;
  // Phase duration string formats:
  //   '$varName' (variable reference, var can be minutes or seconds)
  //   '$varName m' (legacy: '$varName 米')
  //   '0' (rest)
  const trimmed = phase.duration.trim();
  if (trimmed === '0') return 0;
  const match = trimmed.match(/^\$(\w+)(.*)$/);
  if (!match) return null;
  const varName = match[1];
  const suffix = (match[2] ?? '').trim();
  const v = resolved.get(varName);
  if (!v || v.kind !== 'number') return null;

  if (isMetersSuffix(suffix)) {
    // Distance phases (swim) — not counted toward minutes, return 0.
    return 0;
  }
  if (v.unit === 'seconds') {
    return v.value / 60;
  }
  return v.value; // minutes
}

function estimateDistanceKm(
  template: WorkoutTemplate,
  resolved: Map<string, ResolvedValue>,
  durationMinutes: number,
): number | null {
  // Swimming: prefer template totalMeters when present. It is the intended
  // total volume, while phase meter variables are the detailed breakdown.
  if (template.fixed.sport === 'swimming') {
    let totalMeters = 0;
    for (const key of [
      'warmupMeters',
      'mainTotalMeters',
      'drillTotalMeters',
      'cooldownMeters',
      'auxTotalMeters',
    ]) {
      const v = resolved.get(key);
      if (v && v.kind === 'number') totalMeters += v.value;
    }
    if (totalMeters > 0) return Math.round(totalMeters) / 1000;

    const declaredTotal = resolved.get('totalMeters');
    if (declaredTotal?.kind === 'number' && declaredTotal.value > 0) {
      return Math.round(declaredTotal.value) / 1000;
    }
    return null;
  }
  // Running: do not show a total reference distance from planned workouts.
  // Running paces here usually describe the main set, a cap, or an intensity
  // target rather than the full-session average including warmup, recoveries,
  // and cooldown. Showing a total distance would create a second, conflicting
  // prescription beside the workout structure.
  if (template.fixed.sport === 'running') {
    return null;
  }
  return null;
}

function buildWorkoutStructure(
  template: WorkoutTemplate,
  resolved: Map<string, ResolvedValue>,
  targets: { targetHeartRate: string; targetPace: string; targetPower: string },
): string {
  const segmentStructure = buildSegmentWorkoutStructure(template, resolved);
  if (segmentStructure) return segmentStructure;

  const parts: string[] = [];
  for (const phase of template.fixed.phases) {
    const segment = describePhase(phase, resolved, targets);
    if (segment) parts.push(segment);
  }
  if (parts.length === 0) {
    return `${template.fixed.title}: full rest.`;
  }
  return parts.join('; ') + '.';
}

function buildSegmentWorkoutStructure(
  template: WorkoutTemplate,
  resolved: Map<string, ResolvedValue>,
): string | null {
  const type = template.fixed.workoutType;
  if (template.id === 'run.reverse_pyramid.v1') {
    const warmup = integerValue(resolved, 'warmupDuration', 15);
    const recovery = integerValue(resolved, 'recoveryDuration', 3);
    const cooldown = integerValue(resolved, 'cooldownDuration', 13);
    const pace1200 = paceText(resolved, 'pyramid1200Pace', '/km');
    const pace800 = paceText(resolved, 'pyramid800Pace', '/km');
    const pace400 = paceText(resolved, 'pyramid400Pace', '/km');
    if (pace1200 && pace800 && pace400) {
      return [
        `Warm-up ${warmup} min (dynamic stretching, running drills, 4 x 20 s strides)`,
        `Main set 1200 m @ ${pace1200} (~10K effort) + 800 m @ ${pace800} (~5K effort) + 400 m @ ${pace400} (~3K effort), ${recovery} min easy jog between reps`,
        `Cool-down ${cooldown} min`,
      ].join('; ') + '.';
    }
  }

  if (template.id === 'run.progression.v1') {
    const warmup = integerValue(resolved, 'warmupDuration', 10);
    const segment = integerValue(resolved, 'segmentDuration', 15);
    const cooldown = integerValue(resolved, 'cooldownDuration', 8);
    const easy = paceText(resolved, 'easyPace', '/km');
    const mid = paceText(resolved, 'progressionMidPace', '/km');
    const finish = paceText(resolved, 'targetPace', '/km');
    if (easy && mid && finish) {
      return [
        `Warm-up ${warmup} min`,
        `Segment 1 ${segment} min @ ${easy}, low end of Zone 2`,
        `Segment 2 ${segment} min @ ${mid}, steady aerobic`,
        `Segment 3 ${segment} min @ ${finish}, up to the bottom of Tempo only, not threshold`,
        `Cool-down ${cooldown} min`,
      ].join('; ') + '.';
    }
  }

  if (template.id === 'bike.over_under.v1') {
    const warmup = integerValue(resolved, 'warmupDuration', 20);
    const blocks = integerValue(resolved, 'blockRepeats', 3);
    const blockDuration = integerValue(resolved, 'blockDuration', 12);
    const recovery = integerValue(resolved, 'recoveryDuration', 6);
    const cooldown = integerValue(resolved, 'cooldownDuration', 13);
    const under = powerText(resolved, 'underPower');
    const over = powerText(resolved, 'overPower');
    if (under && over) {
      const rounds = Math.max(1, Math.round(blockDuration / 3));
      return [
        `Warm-up ${warmup} min`,
        `Main set ${blocks} x ${blockDuration} min, each block ${rounds} rounds of (2 min ${under} + 1 min ${over}), ${recovery} min easy spin between blocks`,
        `Cool-down ${cooldown} min`,
      ].join('; ') + '.';
    }
  }

  if (template.id === 'swim.sprint.v1') {
    const warmup = integerValue(resolved, 'warmupMeters', 400);
    const reps = integerValue(resolved, 'sprintRepeats', 16);
    const distance = integerValue(resolved, 'sprintDistance', 25);
    const rest = integerValue(resolved, 'sprintRestSeconds', 40);
    const aux = integerValue(resolved, 'easyAuxRepeats', 6);
    const cooldown = integerValue(resolved, 'cooldownMeters', 200);
    const sprintPace = paceText(resolved, 'sprintPace', '/100m');
    const easyPace = paceText(resolved, 'easyPace', '/100m');
    if (sprintPace && easyPace) {
      return [
        `Warm-up ${warmup} m (incl. 4 x 25 m build-ups)`,
        `Main set ${reps} x ${distance} m @ ${sprintPace}, ${rest} s rest between reps`,
        `Aux set ${aux} x 50 m easy technique swim @ ${easyPace}, 20 s rest between reps`,
        `Cool-down ${cooldown} m`,
      ].join('; ') + '.';
    }
  }

  if (type === 'cadence_drill') {
    const warmup = integerValue(resolved, 'warmupDuration', 10);
    const reps = integerValue(resolved, 'drillRepeats', 6);
    const duration = integerValue(resolved, 'drillDuration', 4);
    const recovery = integerValue(resolved, 'drillRecovery', 3);
    const cooldown = integerValue(resolved, 'cooldownDuration', 8);
    const high = stringValue(resolved, 'cadenceHighRange') ?? '100-110 rpm';
    const normal = stringValue(resolved, 'cadenceNormalRange') ?? '85-90 rpm';
    return [
      `Warm-up ${warmup} min`,
      `Main set ${reps} x ${duration} min high cadence ${high}, ${recovery} min at ${normal} between reps`,
      `Cool-down ${cooldown} min`,
    ].join('; ') + '.';
  }

  return null;
}

function describePhase(
  phase: WorkoutPhase,
  resolved: Map<string, ResolvedValue>,
  targets: { targetHeartRate: string; targetPace: string; targetPower: string },
): string {
  if (!phase.duration) {
    return phase.label;
  }
  const trimmed = phase.duration.trim();
  if (trimmed === '0') return `${phase.label}: no training`;

  const match = trimmed.match(/^\$(\w+)(.*)$/);
  if (!match) return `${phase.label} ${trimmed}`;
  const varName = match[1];
  const suffix = (match[2] ?? '').trim();
  const v = resolved.get(varName);

  let durationLabel = '';
  if (v && v.kind === 'number') {
    if (isMetersSuffix(suffix)) {
      durationLabel = `${Math.round(v.value)} m`;
    } else if (v.unit === 'seconds') {
      durationLabel = v.value >= 60
        ? `${Math.round(v.value / 60)} min`
        : `${Math.round(v.value)} s`;
    } else {
      durationLabel = `${Math.round(v.value)} min`;
    }
  }

  const head = durationLabel ? `${phase.label} ${durationLabel}` : phase.label;
  const details: string[] = [];
  const detail = formatPhaseDescription(phase.description, resolved, targets);
  if (detail) details.push(lowercaseLeadingWord(detail));

  // Add target hints for the main phase.
  if (phase.name === 'main') {
    const extras: string[] = [];
    if (targets.targetPace !== NA) extras.push(`pace ${targets.targetPace}`);
    if (targets.targetHeartRate !== NA) extras.push(`HR ${targets.targetHeartRate}`);
    if (targets.targetPower !== NA) extras.push(`power ${targets.targetPower}`);
    if (extras.length > 0) details.push(extras.join(', '));
  }

  return details.length > 0 ? `${head}: ${details.join(', ')}` : head;
}

// "Hold HR.zone2" -> "hold HR.zone2", but leave acronyms such as "CSS" or
// "HR" untouched.
function lowercaseLeadingWord(text: string): string {
  if (/^[A-Z][a-z]/.test(text)) return text.charAt(0).toLowerCase() + text.slice(1);
  return text;
}

function formatPhaseDescription(
  description: string | undefined,
  resolved: Map<string, ResolvedValue>,
  targets: { targetHeartRate: string; targetPace: string; targetPower: string },
): string | null {
  if (!description) return null;
  let out = description.replace(/\$(\w+)/g, (_full, key: string) => {
    return valueText(resolved.get(key)) ?? key;
  });

  const logicalTargets: Record<string, string | null> = {
    'RUN.easyPace': paceText(resolved, 'easyPace', '/km'),
    'RUN.longPace': paceText(resolved, 'longPaceCap', '/km') ?? paceText(resolved, 'targetPace', '/km'),
    'RUN.tempoPace': targets.targetPace !== NA ? targets.targetPace : null,
    'RUN.thresholdPace': targets.targetPace !== NA ? targets.targetPace : null,
    'RUN.intervalPace': targets.targetPace !== NA ? targets.targetPace : null,
    'RUN.vo2Pace': targets.targetPace !== NA ? targets.targetPace : null,
    'RUN.racePace': targets.targetPace !== NA ? targets.targetPace : null,
    'RUN.progressionFinishPace': paceText(resolved, 'targetPace', '/km') ?? (targets.targetPace !== NA ? targets.targetPace : null),
    'SWIM.sprintPace': paceText(resolved, 'sprintPace', '/100m') ?? (targets.targetPace !== NA ? targets.targetPace : null),
    'SWIM.easyPace': paceText(resolved, 'easyPace', '/100m') ?? paceText(resolved, 'easyPaceCap', '/100m'),
  };

  for (const [token, value] of Object.entries(logicalTargets)) {
    if (!value) continue;
    out = out.replace(new RegExp(escapeRegExp(token), 'g'), value);
  }

  return out.replace(/\s+/g, ' ').replace(/[。；;,.，]\s*$/, '').trim();
}

function buildTargetsArray(args: {
  template: WorkoutTemplate;
  targetHeartRate: string;
  targetPace: string;
  targetPower: string;
  durationMinutes: number;
  preferredDurationMinutes: number | null;
  distanceKm: number | null;
  resolved: Map<string, ResolvedValue>;
}): string[] {
  const { template, targetHeartRate, targetPace, targetPower, durationMinutes, distanceKm, preferredDurationMinutes, resolved } = args;
  const out: string[] = [];

  if (durationMinutes > 0) out.push(`Total duration ${durationMinutes} min`);
  else out.push(`Total duration ${NA}`);
  if (
    preferredDurationMinutes !== null &&
    Number.isFinite(preferredDurationMinutes) &&
    durationMinutes > 0 &&
    Math.round(preferredDurationMinutes) === durationMinutes
  ) {
    out.push(`Fitted to your daily time limit of ${durationMinutes} min`);
  }

  if (distanceKm !== null && distanceKm > 0) {
    out.push(`Est. distance ${distanceKm.toFixed(1)} km`);
  }

  if (targetHeartRate !== NA) out.push(`Target HR ${targetHeartRate}`);
  if (targetPace !== NA) out.push(`Target pace ${targetPace}`);
  if (targetPower !== NA) out.push(`Target power ${targetPower}`);
  out.push(...buildSegmentTargets(template, resolved));
  const fueling = fuelingGuidance(template, durationMinutes);
  if (fueling) out.push(fueling);

  // Ensure at least one number-bearing bullet for non-rest workouts.
  if (out.length === 0) out.push(`Reference intensity ${NA}`);
  return out;
}

function buildSegmentTargets(
  template: WorkoutTemplate,
  resolved: Map<string, ResolvedValue>,
): string[] {
  if (template.id === 'run.reverse_pyramid.v1') {
    const pace1200 = paceText(resolved, 'pyramid1200Pace', '/km');
    const pace800 = paceText(resolved, 'pyramid800Pace', '/km');
    const pace400 = paceText(resolved, 'pyramid400Pace', '/km');
    return [
      pace1200 ? `1200 m target pace ${pace1200} (~10K effort)` : null,
      pace800 ? `800 m target pace ${pace800} (~5K effort)` : null,
      pace400 ? `400 m target pace ${pace400} (~3K effort)` : null,
    ].filter((v): v is string => Boolean(v));
  }

  if (template.id === 'run.progression.v1') {
    const segment = integerValue(resolved, 'segmentDuration', 15);
    const easy = paceText(resolved, 'easyPace', '/km');
    const mid = paceText(resolved, 'progressionMidPace', '/km');
    const finish = paceText(resolved, 'targetPace', '/km');
    return [
      easy ? `Progression segment 1: ${segment} min ${easy}` : null,
      mid ? `Progression segment 2: ${segment} min ${mid}` : null,
      finish ? `Progression segment 3: ${segment} min ${finish}` : null,
    ].filter((v): v is string => Boolean(v));
  }

  if (template.id === 'bike.over_under.v1') {
    const under = powerText(resolved, 'underPower');
    const over = powerText(resolved, 'overPower');
    return [
      under ? `Under: 2 min ${under} (95% FTP)` : null,
      over ? `Over: 1 min ${over} (105% FTP)` : null,
    ].filter((v): v is string => Boolean(v));
  }

  if (template.id === 'swim.sprint.v1') {
    const reps = integerValue(resolved, 'sprintRepeats', 16);
    const distance = integerValue(resolved, 'sprintDistance', 25);
    const sprintPace = paceText(resolved, 'sprintPace', '/100m');
    const easyPace = paceText(resolved, 'easyPace', '/100m');
    return [
      sprintPace ? `Sprints ${reps} x ${distance} m target pace ${sprintPace}` : null,
      easyPace ? `Aux easy technique swim ${easyPace}` : null,
    ].filter((v): v is string => Boolean(v));
  }

  return [];
}

function fuelingGuidance(template: WorkoutTemplate, durationMinutes: number): string | null {
  if (!Number.isFinite(durationMinutes) || durationMinutes < 75) return null;
  const type = template.fixed.workoutType;
  const isLong =
    type === 'lsd' ||
    type === 'long_ride' ||
    type === 'endurance' ||
    durationMinutes >= 90;
  if (!isLong) return null;
  if (template.fixed.sport === 'running') {
    return 'Long-session fueling: beyond 75 min, take 30-60 g carbs per hour; hydrate and add electrolytes for the weather';
  }
  if (template.fixed.sport === 'cycling') {
    return 'Long-session fueling: 30-60 g carbs per hour, building toward 60-90 g beyond 90 min; drink every 15-20 min';
  }
  if (template.fixed.sport === 'swimming') {
    return 'Long-session fueling: top up carbs and fluids before the swim; keep a bottle poolside for breaks';
  }
  return null;
}

function buildAdaptation(template: WorkoutTemplate, durationMinutes: number): string {
  if (template.fixed.notes && template.fixed.notes.length > 0) {
    return template.fixed.notes;
  }
  if (durationMinutes <= 0) return 'Full rest day: focus on sleep and hydration.';
  const shortened = Math.max(15, Math.round(durationMinutes * 0.7));
  return `If your legs are sore or you slept poorly, shorten the session to ${shortened} min.`;
}

function inferDowngradeReason(
  template: WorkoutTemplate,
  scheduleEntry: ScheduleEntry,
): string | undefined {
  if (template.id === scheduleEntry.templateId) return undefined;
  return `Scheduler replaced ${scheduleEntry.templateId} with ${template.id}.`;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

function roundSmart(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (Math.abs(n - Math.round(n)) < 1e-6) return Math.round(n);
  return Math.round(n * 10) / 10;
}

function formatSeconds(secPerUnit: number): string {
  if (!Number.isFinite(secPerUnit) || secPerUnit < 0) return NA;
  const total = Math.round(secPerUnit);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function paceSeconds(
  resolved: Map<string, ResolvedValue>,
  key: string,
): number | null {
  const v = resolved.get(key);
  if (!v) return null;
  if (
    v.kind === 'number' &&
    typeof v.unit === 'string' &&
    (v.unit === 's/km' || v.unit === 's/100m')
  ) {
    return v.value;
  }
  if (
    v.kind === 'range' &&
    typeof v.unit === 'string' &&
    (v.unit === 's/km' || v.unit === 's/100m')
  ) {
    return (v.low + v.high) / 2;
  }
  return null;
}

function paceText(
  resolved: Map<string, ResolvedValue>,
  key: string,
  suffix: '/km' | '/100m',
): string | null {
  const v = resolved.get(key);
  if (!v) return null;
  if (v.kind === 'number') {
    if (v.unit === 's/km_upper' || v.unit === 's/100m_upper') {
      return `no faster than ${formatSeconds(v.value)}${suffix}`;
    }
    if (v.unit === 's/km' || v.unit === 's/100m' || !v.unit) {
      return `${formatSeconds(v.value)}${suffix}`;
    }
  }
  if (v.kind === 'range' && (v.unit === 's/km' || v.unit === 's/100m')) {
    if (Math.abs(v.low - v.high) < 0.5) return `${formatSeconds(v.low)}${suffix}`;
    return `${formatSeconds(v.low)}-${formatSeconds(v.high)}${suffix}`;
  }
  return null;
}

function powerText(
  resolved: Map<string, ResolvedValue>,
  key: string,
): string | null {
  const v = resolved.get(key);
  if (!v) return null;
  if (v.kind === 'number') {
    if (v.unit === 'W') return `${Math.round(v.value)} W`;
    if (v.unit === 'W_upper') return `<${Math.round(v.value)} W`;
    if (v.unit === 'W_lower') return `>${Math.round(v.value)} W`;
  }
  if (v.kind === 'range' && v.unit === 'W') {
    return `${Math.round(v.low)}-${Math.round(v.high)} W`;
  }
  return null;
}

function integerValue(
  resolved: Map<string, ResolvedValue>,
  key: string,
  fallback: number,
): number {
  const v = resolved.get(key);
  if (v?.kind === 'number' && Number.isFinite(v.value)) return Math.round(v.value);
  return fallback;
}

function stringValue(
  resolved: Map<string, ResolvedValue>,
  key: string,
): string | null {
  const v = resolved.get(key);
  if (v?.kind === 'string' && v.value.trim()) return v.value.trim();
  return null;
}

function valueText(value: ResolvedValue | undefined): string | null {
  if (!value) return null;
  if (value.kind === 'number') return String(roundSmart(value.value));
  if (value.kind === 'range') {
    if (Math.abs(value.low - value.high) < 0.5) return String(roundSmart(value.low));
    return `${roundSmart(value.low)}-${roundSmart(value.high)}`;
  }
  if (value.kind === 'string') return value.value;
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatForReplacedRecord(value: ResolvedValue): string | number {
  if (value.kind === 'number') return value.value;
  if (value.kind === 'range') return `${value.low}-${value.high}${value.unit ? ' ' + value.unit : ''}`;
  if (value.kind === 'string') return value.value;
  return '';
}
