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
  };
  scheduleEntry: ScheduleEntry;
  progression: 'conservative' | 'normal' | 'aggressive';
}

const NA = '不适用';

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

  // Compute durationMinutes by summing minute-quantified phases (and minute-
  // valued variables they reference) using the resolved values.
  const durationMinutes = computeDurationMinutes(template, resolved, tuning);

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
      return resolveDerived(key, src.rule, ctx);
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

function resolveDerived(key: string, rule: string, ctx: ResolveCtx): ResolvedValue {
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
  const pctSingle = parsePercentSingle(rule);
  if (pctSingle && ftp && ftp > 0) {
    return {
      kind: 'number',
      value: Math.round((ftp * pctSingle.value) / 100),
      unit: 'W',
    };
  }
  // < 55% FTP style upper-bound.
  const pctUpper = parsePercentUpper(rule);
  if (pctUpper && ftp && ftp > 0) {
    return {
      kind: 'number',
      value: Math.round((ftp * pctUpper.value) / 100),
      unit: 'W_upper',
    };
  }

  // Pace adjustments referencing easyPace, longPace, etc.
  const paceAdj = parsePaceOffset(rule);
  if (paceAdj) {
    const basePath = paceAdj.basePath;
    const baseRaw = lookupPath(ctx.athleteProfile, basePath);
    if (typeof baseRaw === 'number' && Number.isFinite(baseRaw)) {
      if (paceAdj.range) {
        return {
          kind: 'range',
          low: baseRaw + paceAdj.range[0],
          high: baseRaw + paceAdj.range[1],
          unit: 's/km',
        };
      }
      return {
        kind: 'number',
        value: baseRaw + paceAdj.singleOffset,
        unit: 's/km_upper',
      };
    }
  }

  // mainDurationTotal style: composed from already-resolved variables.
  const composed = composeMinutesFromOtherVars(rule, ctx);
  if (composed !== null) {
    return { kind: 'number', value: composed, unit: 'minutes' };
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

interface PaceOffsetParse {
  basePath: string;
  range: [number, number] | null;
  singleOffset: number;
}

function parsePaceOffset(rule: string): PaceOffsetParse | null {
  // Examples:
  //   '+30..+50 s/km'          -> base inferred from `from` (caller passes
  //                              athleteProfile.running.<x>SecPerKm typically)
  //   'easyPace + 10..30 s/km' -> base = athleteProfile.running.easyPaceSecPerKm
  //   '+20 s/km (上限，可选)'   -> singleOffset = 20
  //   '+5..15 s/100m (上限)'   -> swimming offset
  const baseMap: Record<string, string> = {
    easyPace: 'athleteProfile.running.easyPaceSecPerKm',
    longPace: 'athleteProfile.running.longPaceSecPerKm',
    tempoPace: 'athleteProfile.running.tempoPaceSecPerKm',
    thresholdPace: 'athleteProfile.running.thresholdPaceSecPerKm',
    racePace: 'athleteProfile.running.racePaceSecPerKm',
    cssPace: 'athleteProfile.swimming.cssPaceSecPer100m',
  };

  let basePath: string | null = null;
  for (const [key, path] of Object.entries(baseMap)) {
    if (rule.includes(key)) {
      basePath = path;
      break;
    }
  }
  // If no explicit base name appears, only handle `+N s/km` upper-bound style.
  if (!basePath) {
    const upper = rule.match(/\+\s*(\d+)\s*s\/km/);
    if (upper) {
      return {
        basePath: 'athleteProfile.running.easyPaceSecPerKm',
        range: null,
        singleOffset: Number(upper[1]),
      };
    }
    const upper100 = rule.match(/\+\s*(\d+)\s*s\/100m/);
    if (upper100) {
      return {
        basePath: 'athleteProfile.swimming.cssPaceSecPer100m',
        range: null,
        singleOffset: Number(upper100[1]),
      };
    }
    return null;
  }

  const rangeMatch = rule.match(/(\d+)\s*\.\.+\s*(\d+)\s*s\/(km|100m)/);
  if (rangeMatch) {
    return {
      basePath,
      range: [Number(rangeMatch[1]), Number(rangeMatch[2])],
      singleOffset: 0,
    };
  }
  const upper = rule.match(/\+\s*(\d+)\s*s\/(km|100m)/);
  if (upper) {
    return { basePath, range: null, singleOffset: Number(upper[1]) };
  }
  return null;
}

function composeMinutesFromOtherVars(rule: string, ctx: ResolveCtx): number | null {
  // Only handle the canonical "n * a + (n - 1) * b" interval-block formula, where
  // 'n' is repeats, 'a' is rep duration, 'b' is recovery duration. We map to
  // already-resolved variables matching naming patterns.
  // Example: "thresholdRepeats * thresholdDuration + (thresholdRepeats - 1) * recoveryDuration"
  const match = rule.match(
    /(\w+)\s*\*\s*(\w+)\s*\+\s*\(\s*\1\s*-\s*1\s*\)\s*\*\s*(\w+)/,
  );
  if (!match) return null;
  const reps = readNumberFromResolved(ctx.resolved.get(match[1]));
  const dur = readNumberFromResolved(ctx.resolved.get(match[2]));
  const rec = readNumberFromResolved(ctx.resolved.get(match[3]));
  if (reps === null || dur === null || rec === null) return null;
  return roundSmart(reps * dur + (reps - 1) * rec);
}

function readNumberFromResolved(v: ResolvedValue | undefined): number | null {
  if (!v) return null;
  if (v.kind === 'number') return v.value;
  return null;
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
      if (v.unit === 'W' || v.unit === 'W_upper') continue;
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

  const candidates = [
    'targetPace',
    'targetPaceCap',
    'longPaceCap',
    'cssPaceRange',
    'cssPace',
    'easyPace',
    'tempoPace',
    'sprintPace',
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
      const isUpperCap = key === 'longPaceCap' || key === 'targetPaceCap';
      if (v.unit === 's/km_upper' || isUpperCap) {
        return `不快于 ${formatSeconds(v.value)}${unit}`;
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
  for (const key of candidates) {
    const v = resolved.get(key);
    if (!v) continue;
    if (v.kind === 'range' && v.unit === 'W') {
      return `${Math.round(v.low)}-${Math.round(v.high)} W`;
    }
    if (v.kind === 'number') {
      if (v.unit === 'W') return `${Math.round(v.value)} W`;
      if (v.unit === 'W_upper') return `<${Math.round(v.value)} W`;
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

function resolvePhaseMinutes(
  phase: WorkoutPhase,
  resolved: Map<string, ResolvedValue>,
): number | null {
  if (!phase.duration) return null;
  // Phase duration string formats:
  //   '$varName' (variable reference, var can be minutes or seconds)
  //   '$varName 米'
  //   '0' (rest)
  const trimmed = phase.duration.trim();
  if (trimmed === '0') return 0;
  const match = trimmed.match(/^\$(\w+)(.*)$/);
  if (!match) return null;
  const varName = match[1];
  const suffix = (match[2] ?? '').trim();
  const v = resolved.get(varName);
  if (!v || v.kind !== 'number') return null;

  if (suffix.includes('米')) {
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
  // Swimming: sum total meters across phases.
  if (template.fixed.sport === 'swimming') {
    let totalMeters = 0;
    for (const key of [
      'totalMeters',
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
    return null;
  }
  // Running: estimate from easyPace + duration (rough).
  if (template.fixed.sport === 'running') {
    const pace =
      resolved.get('targetPace') ??
      resolved.get('easyPace') ??
      resolved.get('longPaceCap') ??
      resolved.get('targetPaceCap');
    let secPerKm: number | null = null;
    if (pace && pace.kind === 'number' && (pace.unit === 's/km' || pace.unit === 's/km_upper' || pace.unit === undefined)) {
      secPerKm = pace.value;
    } else if (pace && pace.kind === 'range' && pace.unit === 's/km') {
      secPerKm = (pace.low + pace.high) / 2;
    }
    if (secPerKm && secPerKm > 0 && durationMinutes > 0) {
      const km = (durationMinutes * 60) / secPerKm;
      return Math.round(km * 10) / 10;
    }
    return null;
  }
  return null;
}

function buildWorkoutStructure(
  template: WorkoutTemplate,
  resolved: Map<string, ResolvedValue>,
  targets: { targetHeartRate: string; targetPace: string; targetPower: string },
): string {
  const parts: string[] = [];
  for (const phase of template.fixed.phases) {
    const segment = describePhase(phase, resolved, targets);
    if (segment) parts.push(segment);
  }
  if (parts.length === 0) {
    return `${template.fixed.title}：完全休息。`;
  }
  return parts.join('；') + '。';
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
  if (trimmed === '0') return `${phase.label}：不安排训练`;

  const match = trimmed.match(/^\$(\w+)(.*)$/);
  if (!match) return `${phase.label} ${trimmed}`;
  const varName = match[1];
  const suffix = (match[2] ?? '').trim();
  const v = resolved.get(varName);

  let durationLabel = '';
  if (v && v.kind === 'number') {
    if (suffix.includes('米')) {
      durationLabel = `${Math.round(v.value)} 米`;
    } else if (v.unit === 'seconds') {
      durationLabel = `${Math.round(v.value)} 秒`;
    } else {
      durationLabel = `${Math.round(v.value)} 分钟`;
    }
  }

  const pieces = [phase.label];
  if (durationLabel) pieces.push(durationLabel);

  // Add target hints for the main phase.
  if (phase.name === 'main') {
    const extras: string[] = [];
    if (targets.targetPace !== NA) extras.push(`配速 ${targets.targetPace}`);
    if (targets.targetHeartRate !== NA) extras.push(`心率 ${targets.targetHeartRate}`);
    if (targets.targetPower !== NA) extras.push(`功率 ${targets.targetPower}`);
    if (extras.length > 0) pieces.push(extras.join('，'));
  }

  return pieces.join(' ');
}

function buildTargetsArray(args: {
  template: WorkoutTemplate;
  targetHeartRate: string;
  targetPace: string;
  targetPower: string;
  durationMinutes: number;
  distanceKm: number | null;
  resolved: Map<string, ResolvedValue>;
}): string[] {
  const { template, targetHeartRate, targetPace, targetPower, durationMinutes, distanceKm } = args;
  const out: string[] = [];

  if (durationMinutes > 0) out.push(`总时长 ${durationMinutes} 分钟`);
  else out.push('总时长 不适用');

  if (distanceKm !== null && distanceKm > 0) {
    out.push(`参考距离 ${distanceKm.toFixed(1)} 公里`);
  }

  if (targetHeartRate !== NA) out.push(`目标心率 ${targetHeartRate}`);
  if (targetPace !== NA) out.push(`目标配速 ${targetPace}`);
  if (targetPower !== NA) out.push(`目标功率 ${targetPower}`);

  // Ensure at least one number-bearing bullet for non-rest workouts.
  if (out.length === 0) out.push('参考强度 不适用');
  return out;
}

function buildAdaptation(template: WorkoutTemplate, durationMinutes: number): string {
  if (template.fixed.notes && template.fixed.notes.length > 0) {
    return template.fixed.notes;
  }
  if (durationMinutes <= 0) return '完全休息日，专注睡眠和补水。';
  const shortened = Math.max(15, Math.round(durationMinutes * 0.7));
  return `如果腿酸或睡眠差，将主训练缩短至 ${shortened} 分钟。`;
}

function inferDowngradeReason(
  template: WorkoutTemplate,
  scheduleEntry: ScheduleEntry,
): string | undefined {
  if (template.id === scheduleEntry.templateId) return undefined;
  return `调度阶段已将 ${scheduleEntry.templateId} 替换为 ${template.id}。`;
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

function formatForReplacedRecord(value: ResolvedValue): string | number {
  if (value.kind === 'number') return value.value;
  if (value.kind === 'range') return `${value.low}-${value.high}${value.unit ? ' ' + value.unit : ''}`;
  if (value.kind === 'string') return value.value;
  return '';
}
