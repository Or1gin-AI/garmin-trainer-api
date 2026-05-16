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
const NA = '不适用';
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
          '为给定模板填入数值参数并生成中文训练课内容。模板的 sport / phases 不可改变。',
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
            targetHeartRate: { type: 'string', description: '形如 "132-146 bpm" 或 "不适用"' },
            targetPace: { type: 'string', description: '跑步以 /km，游泳以 /100m 结尾，骑行必须为 不适用' },
            targetPower: { type: 'string', description: '骑行以 W 结尾，否则 不适用' },
            workoutStructure: { type: 'string', description: '中文一段，包含数字' },
            targets: {
              type: 'array',
              items: { type: 'string' },
              description: '中文要点列表，每项包含数字或"不适用"',
              minItems: 1,
            },
            adaptation: { type: 'string', description: '若疲劳/伤病时如何调整训练' },
            variables: {
              type: 'object',
              additionalProperties: { type: ['string', 'number'] },
              description: '所选关键变量数值，便于审计 — key 与模板的 variables 名一致',
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
  const durationMinutes = applyPreferredDuration(
    template,
    parsedDurationMinutes,
    request.dailyPreferredMinutes ?? null,
    scheduleEntry.durationCapMinutes ?? null,
  );

  const parsedDistanceKm =
    typeof parsed.distanceKm === 'number' && Number.isFinite(parsed.distanceKm)
      ? Math.round(parsed.distanceKm * 100) / 100
      : null;
  const distanceKm = sanitizeLlmDistanceKm(template, parsedDistanceKm);

  // Strings — coerce undefined to NA / empty, then format-validate.
  const targetHeartRate = typeof parsed.targetHeartRate === 'string' && parsed.targetHeartRate.trim()
    ? parsed.targetHeartRate.trim()
    : NA;
  const targetPace = typeof parsed.targetPace === 'string' && parsed.targetPace.trim()
    ? parsed.targetPace.trim()
    : NA;
  const targetPower = typeof parsed.targetPower === 'string' && parsed.targetPower.trim()
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
  if (distanceKm !== null && distanceKm > 0 && !targets.some((t) => /^参考距离/.test(t))) {
    targets.splice(1, 0, `参考距离 ${distanceKm.toFixed(1)} 公里`);
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

    // targets must each contain a digit (or be 不适用).
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
    workoutStructure: workoutStructure || `${template.fixed.title}：${template.fixed.purpose}`,
    targets: targets.length > 0 ? targets : [`总时长 ${durationMinutes} 分钟`],
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
  return !/^参考距离/.test(text);
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
  return Math.min(upper, Math.max(lower, resolved));
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
    '你是一位专业运动教练，正在把一个固定结构的训练模板填上数值参数与中文文字内容。',
  );
  systemParts.push('硬性约束：');
  systemParts.push('- 模板的 sport、phases、purpose、intensity 不可更改；');
  if (sport === 'cycling') {
    systemParts.push(`- targetPace 必须等于 "${NA}"；`);
  }
  if (sport === 'running') {
    systemParts.push('- targetPace 必须以 /km 结尾（如 "5:10/km" 或 "5:00-5:10/km"）；');
  }
  if (sport === 'swimming') {
    systemParts.push('- targetPace 必须以 /100m 结尾；');
  }
  systemParts.push('- targetHeartRate 必须包含 "bpm"，否则填 "不适用"；');
  systemParts.push('- 非休息日必须给出 HR / 配速 / 功率 中至少一个有数值；');
  systemParts.push('- workoutStructure 是中文一段话，必须含数字；targets 至少 1 项，每项含数字（或"不适用"）；');
  systemParts.push('- 数值需在模板 variables 给定的 min..max 之内（如未给出则参考运动员档案）；');
  systemParts.push('- 分段训练必须逐段写清目标；不同强度段不能复用同一个配速/功率/心率，除非模板明确要求稳定阈值。');
  systemParts.push(
    `- 当前 progression=${args.progression}，对照模板的 progression 调整时长和重复次数。`,
  );
  if (args.request.dailyPreferredMinutes && args.request.dailyPreferredMinutes > 0) {
    systemParts.push(
      `- 用户填写的 ${args.request.dailyPreferredMinutes} 分钟是单日可用上限，不是必须凑满的目标；若模板默认时长更短，不要为了凑时长增加阈值/VO2/间歇总量。`,
    );
  }
  if (args.scheduleEntry.durationCapMinutes && args.scheduleEntry.durationCapMinutes > 0) {
    systemParts.push(
      `- 训练容量保护：本节课总时长不得超过 ${args.scheduleEntry.durationCapMinutes} 分钟（${args.scheduleEntry.durationCapReason ?? '容量上限'}）。`,
    );
  }
  if (
    args.template.fixed.workoutType === 'lsd' ||
    args.template.fixed.workoutType === 'long_ride' ||
    args.template.fixed.maxDurationMinutes >= 90
  ) {
    systemParts.push(
      '- 若最终总时长 >=75 分钟，targets 必须包含补给/补水建议：长课每小时 30-60g 碳水，骑行 90 分钟以上可接近 60-90g，并按天气补水和电解质。',
    );
  }
  if (args.request.availableTime) {
    systemParts.push(`- 用户可用时间说明：${args.request.availableTime}`);
  }
  if (args.isColdStart) {
    systemParts.push(
      '- 该用户结构化训练历史很少；优先使用保守训练量和体感描述，不要强行给激进配速/功率。',
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
      content: `请用 ${TOOL_NAME} 工具返回该课的最终参数。\n\n${JSON.stringify(user, null, 2)}`,
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
