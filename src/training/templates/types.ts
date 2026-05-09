// Workout template type system (U5).
//
// Pure data + types: no compute, no I/O, no LLM calls.
// Templates are translated verbatim from the cofounder's
// training-plan-generation-refactor.md. Per that spec:
//   - `fixed.*` is immutable: sport, workoutType, title, purpose,
//     intensity, stress, primaryMetric, phases, contraindications,
//     downgradeRule.
//   - `variables.*` are placeholders the parameterizer (U7) fills
//     from the athlete profile (U6) or runtime args.
//
// The parameterizer is responsible for:
//   - resolving `$varName` placeholders inside phase durations / labels
//   - downgrading primaryMetric when data confidence is low
//   - converting numeric pace/HR ranges to display strings like
//     "5:00-5:10/km" or "132-146 bpm"
//   - estimating distance from duration and pace where applicable

export type Sport =
  | 'running'
  | 'cycling'
  | 'swimming'
  | 'rest'
  | 'strength'
  | 'mobility';

export type Intensity = 'low' | 'medium' | 'high';
export type Stress = 'low' | 'medium' | 'high';
export type PrimaryMetric = 'heart_rate' | 'pace' | 'power' | 'mixed' | 'none';

// A phase within a workout. Durations may reference `$varName` placeholders
// that the parameterizer resolves from `variables`.
export interface WorkoutPhase {
  name: 'warmup' | 'main' | 'cooldown' | 'drill' | 'main_set' | 'aux';
  label: string;
  duration?: string;
  description?: string;
}

// Where a variable's value comes from at parameterization time.
//
//   - template_default: a literal default baked into the template
//     (warmup duration, default repeat counts, etc).
//   - athlete_profile: looked up by path on the athlete profile object
//     produced by U6's buildAthleteProfile. Optional min/max clamp the
//     resolved numeric value.
//   - derived: computed by parameterizer from another value via the named
//     rule. Rule strings are human-readable and reproduce the cofounder
//     spec's phrasing (e.g. "+30..+50 s/km").
//   - llm_choice: the LLM may pick a value within [min, max]; parameterizer
//     validates the chosen value falls in range.
export type VariableSource =
  | { kind: 'template_default'; default: number | string; unit?: string }
  | {
      kind: 'athlete_profile';
      path: string;
      min?: number;
      max?: number;
      unit?: string;
      optional?: boolean;
    }
  | { kind: 'derived'; from: string; rule: string; unit?: string; optional?: boolean }
  | { kind: 'llm_choice'; min?: number; max?: number; unit?: string; default?: number };

export interface TemplateVariable {
  source: VariableSource;
  description?: string;
}

// Hard rules under which the scheduler must not pick this template.
//
// Format `<category>.<key>`. Scheduler evaluates against:
//   - latestStimulus.*   recentState.latestStimulus
//   - fatigue.*          recentState.fatigue
//   - hardSessions.atCap recentState.hardSessionsLast7d >= request.maxHardSessionsPerWeek
//   - injury.*           athleteProfile.injuries (string array of keywords)
//   - confidence.low     athleteProfile.<sport>.confidence === 'low'
export type Contraindication =
  | 'latestStimulus.threshold'
  | 'latestStimulus.vo2max'
  | 'latestStimulus.anaerobic'
  | 'latestStimulus.recovery'
  | 'latestStimulus.aerobic'
  | 'latestStimulus.long_endurance'
  | 'latestStimulus.tempo'
  | 'latestStimulus.sprint'
  | 'fatigue.tired'
  | 'fatigue.high_risk'
  | 'hardSessions.atCap'
  | 'injury.knee'
  | 'injury.achilles'
  | 'injury.calf'
  | 'injury.shoulder'
  | 'injury.hip'
  | 'injury.lower_back'
  | 'confidence.low';

// Multipliers / deltas applied at parameterize time per progression bucket.
// See cofounder spec "模板公共降级和升级规则":
//   conservative: 70-85% volume, -1 to -3 high-intensity reps
//   normal:       100% volume, base reps
//   aggressive:   105-115% volume, +1 to +2 reps
export interface ProgressionTuning {
  durationMultiplier: number;
  repeatDelta: number;
}

export interface WorkoutTemplateFixed {
  sport: Sport;
  workoutType: string;
  title: string;
  purpose: string;
  intensity: Intensity;
  stress: Stress;
  primaryMetric: PrimaryMetric;
  // Permitted fallback metrics. The first element should equal primaryMetric.
  // Parameterizer may downgrade to a later element if data confidence is low.
  allowedMetrics: PrimaryMetric[];
  phases: WorkoutPhase[];
  contraindications: Contraindication[];
  // Template id to fall back to when contraindications fire. Null means
  // schedule a rest day (rest.full.v1 by convention).
  downgradeTo: string | null;
  // Recovery hours that should elapse before scheduling another high-stress
  // session that loads the same physiological system. 0 = no enforced gap.
  requiredRecoveryHoursAfter: number;
  minDurationMinutes: number;
  maxDurationMinutes: number;
  notes?: string;
}

export interface WorkoutTemplate {
  id: string;
  fixed: WorkoutTemplateFixed;
  variables: Record<string, TemplateVariable>;
  progression: {
    conservative: ProgressionTuning;
    normal: ProgressionTuning;
    aggressive: ProgressionTuning;
  };
}
