// LLM-driven parameter filling for ONE workout day (U9).
//
// Returns a fully formed ParameterizedWorkout for the given (template, day,
// progression). Format invariants from validation.ts are pre-checked here so
// the orchestrator can fall back per-day on failure.
//
// Provider-agnostic — same OpenAI SDK shape as everything else.

import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import {
  streamChat,
  completeChat,
  extractJsonObjectText,
  getActiveLlmConfig,
  shouldUseNonStreamingToolCalls,
} from '../lib/llm.js';
import type { AthleteProfile } from './athlete-profile.js';
import type { RecentState } from './recent-state.js';
import { MAX_WEEKLY_TRAINING_MINUTES, type ScheduleEntry } from './scheduler.js';
import { parameterizeWorkout, type ParameterizedWorkout } from './parameterizer.js';
import type { WorkoutTemplate, PrimaryMetric, Intensity } from './templates/types.js';
import { NOT_APPLICABLE, isNotApplicable } from './not-applicable.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class InvalidLlmWorkoutError extends Error {
  readonly violations: string[];
  constructor(violations: string[]) {
    super(`LLM workout invalid: ${violations.join('; ')}`);
    this.name = 'InvalidLlmWorkoutError';
    this.violations = violations;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LlmParameterizeArgs {
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
  isColdStart?: boolean;
  signal?: AbortSignal;
}

export interface LlmParameterizeResult {
  workout: ParameterizedWorkout;
  meta: { inputTokens: number; outputTokens: number };
}

interface LlmWorkoutPayload {
  durationMinutes?: number;
  distanceKm?: number | null;
  targetMetric?: string;
  targetHeartRate?: string;
  targetPace?: string;
  targetPower?: string;
  workoutStructure?: string;
  targets?: string[];
  adaptation?: string;
  variables?: Record<string, string | number>;
}

const TOOL_NAME = 'parameterize_workout';
const PARAMETERIZE_TOOL_CALL_TIMEOUT_MS = 12_000;
const NA = NOT_APPLICABLE;
const DETERMINISTIC_PARAMETERIZATION_TEMPLATE_IDS = new Set([
  'run.reverse_pyramid.v1',
  'run.progression.v1',
  'bike.over_under.v1',
  'bike.cadence_drill.v1',
  'swim.sprint.v1',
  'swim.kick.v1',
  'swim.pull.v1',
  'swim.open_water.v1',
]);

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function llmParameterizeWorkout(
  args: LlmParameterizeArgs,
): Promise<LlmParameterizeResult> {
  const { template, athleteProfile, recentState, request, scheduleEntry, progression } = args;

  if (requiresDeterministicParameterization(template)) {
    return {
      workout: deterministicGuardWorkout(args),
      meta: { inputTokens: 0, outputTokens: 0 },
    };
  }

  const tools: ChatCompletionTool[] = [
    {
      type: 'function',
      function: {
        name: TOOL_NAME,
        description:
          'Fill in the numeric parameters for the given template and write the workout content in English. The template\'s sport / phases must not change.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: [
            'durationMinutes',
            'targetHeartRate',
            'targetPace',
            'targetPower',
            'workoutStructure',
            'targets',
            'adaptation',
          ],
          properties: {
            durationMinutes: {
              type: 'integer',
              minimum: 0,
              maximum: MAX_WEEKLY_TRAINING_MINUTES,
            },
            distanceKm: { type: ['number', 'null'] },
            targetMetric: {
              type: 'string',
              enum: ['heart_rate', 'pace', 'power', 'mixed', 'none'],
            },
            targetHeartRate: { type: 'string', description: 'e.g. "132-146 bpm" or "N/A"' },
            targetPace: { type: 'string', description: 'Running ends with /km, swimming ends with /100m; cycling must be "N/A"' },
            targetPower: { type: 'string', description: 'Cycling ends with W; otherwise "N/A"' },
            workoutStructure: { type: 'string', description: 'One English paragraph that contains numbers' },
            targets: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of short English bullet points; each item contains a number or "N/A"',
              minItems: 1,
            },
            adaptation: { type: 'string', description: 'In English: how to adjust the session when fatigued or injured' },
            variables: {
              type: 'object',
              additionalProperties: { type: ['string', 'number'] },
              description: 'Chosen values of the key variables for auditing; keys match the template variables names',
            },
          },
        },
      },
    },
  ];

  const messages = buildMessages({
    template,
    athleteProfile,
    recentState,
    request,
    scheduleEntry,
    progression,
    isColdStart: args.isColdStart ?? false,
  });

  const config = await getActiveLlmConfig();
  if (shouldUseNonStreamingToolCalls(config)) {
    const completion = await completeChat({
      messages,
      tools,
      toolChoice: { type: 'function', function: { name: TOOL_NAME } },
      temperature: 0.5,
      timeoutMs: PARAMETERIZE_TOOL_CALL_TIMEOUT_MS,
      signal: args.signal,
    });
    const toolCall = completion.choices?.[0]?.message?.tool_calls?.find(
      (tc) =>
        tc.type === 'function' &&
        'function' in tc &&
        tc.function?.name === TOOL_NAME,
    ) as { function?: { arguments?: string } } | undefined;
    const argsBuffer =
      toolCall?.function?.arguments ??
      extractJsonObjectText(completion.choices?.[0]?.message?.content);
    if (argsBuffer.length === 0) {
      throw new InvalidLlmWorkoutError(['model did not emit tool call']);
    }

    let parsed: LlmWorkoutPayload;
    try {
      parsed = JSON.parse(argsBuffer) as LlmWorkoutPayload;
    } catch (err) {
      throw new InvalidLlmWorkoutError([
        `JSON parse failed: ${(err as Error).message}`,
      ]);
    }

    return {
      workout: validateAndBuild({
        parsed,
        template,
        request,
        scheduleEntry,
        progression,
      }),
      meta: {
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
      },
    };
  }

  const stream = await streamChat({
    messages,
    tools,
    toolChoice: { type: 'function', function: { name: TOOL_NAME } },
    temperature: 0.5,
    timeoutMs: PARAMETERIZE_TOOL_CALL_TIMEOUT_MS,
    signal: args.signal,
  });

  // Per-index accumulator: see the matching comment in llm-scheduler.ts.
  const argsByIndex = new Map<number, string>();
  const indexOrder: number[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const chunk of stream) {
    if (args.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const choice = chunk.choices?.[0];
    const toolCalls = choice?.delta?.tool_calls;
    if (toolCalls && toolCalls.length > 0) {
      for (const tc of toolCalls) {
        const idx = typeof tc.index === 'number' ? tc.index : 0;
        if (!argsByIndex.has(idx)) {
          argsByIndex.set(idx, '');
          indexOrder.push(idx);
        }
        const piece = tc.function?.arguments;
        if (typeof piece === 'string' && piece.length > 0) {
          argsByIndex.set(idx, (argsByIndex.get(idx) ?? '') + piece);
        }
      }
    }
    const usage = chunk.usage;
    if (usage) {
      inputTokens = usage.prompt_tokens ?? inputTokens;
      outputTokens = usage.completion_tokens ?? outputTokens;
    }
  }

  const firstIndex = indexOrder[0];
  const argsBuffer =
    firstIndex !== undefined ? (argsByIndex.get(firstIndex) ?? '') : '';
  if (argsBuffer.length === 0) {
    throw new InvalidLlmWorkoutError(['model did not emit tool call']);
  }

  let parsed: LlmWorkoutPayload;
  try {
    parsed = JSON.parse(argsBuffer) as LlmWorkoutPayload;
  } catch (err) {
    throw new InvalidLlmWorkoutError([
      `JSON parse failed: ${(err as Error).message}`,
    ]);
  }

  const workout = validateAndBuild({
    parsed,
    template,
    request,
    scheduleEntry,
    progression,
  });

  return {
    workout,
    meta: { inputTokens, outputTokens },
  };
}

function requiresDeterministicParameterization(template: WorkoutTemplate): boolean {
  return DETERMINISTIC_PARAMETERIZATION_TEMPLATE_IDS.has(template.id);
}

function deterministicGuardWorkout(
  args: LlmParameterizeArgs,
  source = 'deterministic_parameterization_guard',
): ParameterizedWorkout {
  const workout = parameterizeWorkout({
    template: args.template,
    athleteProfile: args.athleteProfile,
    recentState: args.recentState,
    request: args.request,
    scheduleEntry: args.scheduleEntry,
    progression: args.progression,
  });
  return {
    ...workout,
    parameterSource: {
      ...workout.parameterSource,
      replacedVariables: {
        ...workout.parameterSource.replacedVariables,
        __source: source,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Validation + assembly
// ---------------------------------------------------------------------------

interface ValidateBuildArgs {
  parsed: LlmWorkoutPayload;
  template: WorkoutTemplate;
  request: LlmParameterizeArgs['request'];
  scheduleEntry: ScheduleEntry;
  progression: 'conservative' | 'normal' | 'aggressive';
}

function validateAndBuild(args: ValidateBuildArgs): ParameterizedWorkout {
  const violations: string[] = [];
  const { parsed, template, request, scheduleEntry, progression } = args;
  const sport = template.fixed.sport;

  const parsedDurationMinutes = Number.isFinite(parsed.durationMinutes)
    ? Math.max(0, Math.round(parsed.durationMinutes ?? 0))
    : 0;
  const durationMinutes = parsedDurationMinutes;

  const parsedDistanceKm =
    typeof parsed.distanceKm === 'number' && Number.isFinite(parsed.distanceKm)
      ? Math.round(parsed.distanceKm * 100) / 100
      : null;
  const distanceKm = sanitizeLlmDistanceKm(template, parsedDistanceKm);

  // Strings — coerce undefined to NA / empty, then format-validate.
  // Normalize every "not applicable" spelling (N/A, legacy 不适用, empty) to NA.
  const targetHeartRate = typeof parsed.targetHeartRate === 'string' && !isNotApplicable(parsed.targetHeartRate)
    ? parsed.targetHeartRate.trim()
    : NA;
  const targetPace = typeof parsed.targetPace === 'string' && !isNotApplicable(parsed.targetPace)
    ? parsed.targetPace.trim()
    : NA;
  const targetPower = typeof parsed.targetPower === 'string' && !isNotApplicable(parsed.targetPower)
    ? parsed.targetPower.trim()
    : NA;
  const workoutStructure = typeof parsed.workoutStructure === 'string' && parsed.workoutStructure.trim()
    ? parsed.workoutStructure.trim()
    : '';
  const adaptation = typeof parsed.adaptation === 'string' && parsed.adaptation.trim()
    ? parsed.adaptation.trim()
    : (template.fixed.notes ?? '');
  const targets: string[] = Array.isArray(parsed.targets)
    ? parsed.targets.filter((t): t is string => isUsefulTarget(t))
    : [];
  if (distanceKm !== null && distanceKm > 0 && !targets.some((t) => /^(?:参考距离|Est\. distance)/.test(t))) {
    targets.splice(1, 0, `Est. distance ${distanceKm.toFixed(1)} km`);
  }

  const isRest = sport === 'rest' || sport === 'mobility';

  if (!isRest) {
    // Pace format.
    if (sport === 'cycling' && targetPace !== NA) {
      violations.push(`cycling targetPace must be "${NA}", got "${targetPace}"`);
    }
    if (sport === 'running' && targetPace !== NA && !targetPace.includes('/km')) {
      violations.push(`running targetPace missing /km suffix: "${targetPace}"`);
    }
    if (sport === 'swimming' && targetPace !== NA && !targetPace.includes('/100m')) {
      violations.push(`swimming targetPace missing /100m suffix: "${targetPace}"`);
    }

    // HR format.
    if (targetHeartRate !== NA && !targetHeartRate.includes('bpm')) {
      violations.push(`targetHeartRate missing bpm: "${targetHeartRate}"`);
    }

    // At least one numeric target.
    if (targetHeartRate === NA && targetPace === NA && targetPower === NA) {
      violations.push('non-rest day must have at least one of HR/pace/power');
    }

    // workoutStructure must contain a number.
    if (!workoutStructure || !/\d/.test(workoutStructure)) {
      violations.push('workoutStructure must contain at least one numeric token');
    }

    // targets must each contain a digit (or be N/A).
    for (const t of targets) {
      if (!/\d/.test(t) && !t.includes(NA)) {
        violations.push(`unquantified target: "${t}"`);
        break;
      }
    }
    if (targets.length === 0) {
      violations.push('targets array empty for non-rest day');
    }
  }

  // Power required but empty: cycling power templates.
  if (
    sport === 'cycling' &&
    template.fixed.primaryMetric === 'power' &&
    targetPower === NA
  ) {
    // Allowed only if the template's allowedMetrics includes heart_rate AND HR is set.
    const canDowngradeToHr =
      template.fixed.allowedMetrics.includes('heart_rate') && targetHeartRate !== NA;
    if (!canDowngradeToHr) {
      violations.push('cycling power-primary template needs targetPower or HR fallback');
    }
  }

  if (violations.length > 0) {
    throw new InvalidLlmWorkoutError(violations);
  }

  // targetMetric — accept the model's pick if valid, else fall through.
  const targetMetric = pickValidTargetMetric(parsed.targetMetric, template);
  const intensity: Intensity = template.fixed.intensity;

  const replaced: Record<string, string | number> = {};
  if (parsed.variables && typeof parsed.variables === 'object') {
    for (const [k, v] of Object.entries(parsed.variables)) {
      if (typeof v === 'string' || typeof v === 'number') replaced[k] = v;
    }
  }

  return {
    templateId: template.id,
    sport,
    workoutType: template.fixed.workoutType,
    title: template.fixed.title,
    intensity,
    durationMinutes,
    distanceKm,
    targetMetric,
    targetHeartRate,
    targetPace,
    targetPower,
    workoutStructure: workoutStructure || `${template.fixed.title}: ${template.fixed.purpose}`,
    targets: targets.length > 0 ? targets : [`Total duration ${durationMinutes} min`],
    parameterSource: {
      templateId: template.id,
      progression,
      replacedVariables: replaced,
    },
    adaptation,
  };
}

function sanitizeLlmDistanceKm(template: WorkoutTemplate, distanceKm: number | null): number | null {
  if (distanceKm === null || distanceKm <= 0) return null;
  if (template.fixed.sport !== 'running') return distanceKm;
  return null;
}

function isUsefulTarget(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  return !/^(?:参考距离|Est\. distance)/.test(text);
}

function pickValidTargetMetric(
  raw: string | undefined,
  template: WorkoutTemplate,
): PrimaryMetric {
  const valid: PrimaryMetric[] = ['heart_rate', 'pace', 'power', 'mixed', 'none'];
  if (raw && (valid as string[]).includes(raw)) {
    const cast = raw as PrimaryMetric;
    if (cast === template.fixed.primaryMetric) return cast;
    if (template.fixed.allowedMetrics.includes(cast)) return cast;
  }
  return template.fixed.primaryMetric;
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

interface BuildMessagesArgs {
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
  isColdStart: boolean;
}

function buildMessages(args: BuildMessagesArgs): ChatCompletionMessageParam[] {
  const sport = args.template.fixed.sport;

  const systemParts: string[] = [];
  systemParts.push(
    'You are a professional endurance coach filling a fixed-structure workout template with numeric parameters and written workout content.',
  );
  systemParts.push(
    'Language: every natural-language field you return (workoutStructure, targets, adaptation) must be written in English, even if the template, profile or user notes contain another language.',
  );
  systemParts.push('Hard constraints:');
  systemParts.push('- The template\'s sport, phases, purpose and intensity must not change;');
  if (sport === 'cycling') {
    systemParts.push(`- targetPace must equal "${NA}";`);
  }
  if (sport === 'running') {
    systemParts.push('- targetPace must end with /km (e.g. "5:10/km" or "5:00-5:10/km");');
  }
  if (sport === 'swimming') {
    systemParts.push('- targetPace must end with /100m;');
  }
  systemParts.push(`- targetHeartRate must contain "bpm"; otherwise use "${NA}";`);
  systemParts.push('- A non-rest day must give a numeric value for at least one of HR / pace / power;');
  systemParts.push(`- workoutStructure is one English paragraph and must contain numbers (use "min", "s", "m", "km" units); targets has at least 1 item and each item contains a number (or "${NA}");`);
  systemParts.push('- Values must stay within the min..max given by the template variables (if none is given, use the athlete profile as reference);');
  systemParts.push('- Segmented workouts must state the target of each segment; different intensity segments must not reuse the same pace/power/heart rate unless the template explicitly asks for a steady threshold.');
  systemParts.push(
    `- Current progression=${args.progression}; adjust durations and repeat counts according to the template's progression.`,
  );
  if (args.request.dailyPreferredMinutes && args.request.dailyPreferredMinutes > 0) {
    systemParts.push(
      `- The user's ${args.request.dailyPreferredMinutes} min is the maximum time available that day, not a target that must be filled; if the template default is shorter, do not add threshold/VO2/interval volume just to fill time.`,
    );
  }
  if (args.scheduleEntry.durationCapMinutes && args.scheduleEntry.durationCapMinutes > 0) {
    systemParts.push(
      `- Training-capacity protection: this session's total duration must not exceed ${args.scheduleEntry.durationCapMinutes} min (${args.scheduleEntry.durationCapReason ?? 'capacity cap'}).`,
    );
  }
  if (
    args.template.fixed.workoutType === 'lsd' ||
    args.template.fixed.workoutType === 'long_ride' ||
    args.template.fixed.maxDurationMinutes >= 90
  ) {
    systemParts.push(
      '- If the final total duration is >= 75 min, targets must include fueling/hydration advice: 30-60 g carbohydrate per hour for long sessions, approaching 60-90 g for rides over 90 min, plus fluids and electrolytes adjusted for the weather.',
    );
  }
  if (args.request.availableTime) {
    systemParts.push(`- User's note on available time: ${args.request.availableTime}`);
  }
  if (args.isColdStart) {
    systemParts.push(
      '- This user has very little structured training history; prefer conservative volume and perceived-effort descriptions, and do not force aggressive pace/power targets.',
    );
  }

  const user = {
    template: {
      id: args.template.id,
      sport,
      title: args.template.fixed.title,
      purpose: args.template.fixed.purpose,
      intensity: args.template.fixed.intensity,
      primaryMetric: args.template.fixed.primaryMetric,
      allowedMetrics: args.template.fixed.allowedMetrics,
      minDurationMinutes: args.template.fixed.minDurationMinutes,
      maxDurationMinutes: args.template.fixed.maxDurationMinutes,
      contraindications: args.template.fixed.contraindications,
      phases: args.template.fixed.phases,
      variables: args.template.variables,
      progression: args.template.progression[args.progression],
      notes: args.template.fixed.notes ?? null,
    },
    schedule: {
      dayIndex: args.scheduleEntry.dayIndex,
      date: args.scheduleEntry.date,
      dayLabel: args.scheduleEntry.dayLabel,
    },
    isColdStart: args.isColdStart,
    request: args.request,
    athleteProfileForSport: profileSubsetForSport(args.athleteProfile, sport),
    heartRate: args.athleteProfile.heartRate,
    recentState: {
      latestStimulus: args.recentState.latestStimulus,
      fatigue: args.recentState.fatigue,
      hardSessionsLast7d: args.recentState.hardSessionsLast7d,
      load7d: args.recentState.load7d,
      load28d: args.recentState.load28d,
      loadTrend: args.recentState.loadTrend,
      recommendation: args.recentState.recommendation,
    },
  };

  return [
    { role: 'system', content: systemParts.join('\n') },
    {
      role: 'user',
      content: `Use the ${TOOL_NAME} tool to return the final parameters for this session (all text in English).\n\n${JSON.stringify(user, null, 2)}`,
    },
  ];
}

function profileSubsetForSport(
  profile: AthleteProfile,
  sport: string,
): unknown {
  if (sport === 'running') return profile.running;
  if (sport === 'cycling') return profile.cycling;
  if (sport === 'swimming') return profile.swimming;
  return null;
}
