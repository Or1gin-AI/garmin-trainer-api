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
import { streamChat } from '../lib/llm.js';
import type { AthleteProfile } from './athlete-profile.js';
import type { RecentState } from './recent-state.js';
import type { ScheduleEntry } from './scheduler.js';
import type { ParameterizedWorkout } from './parameterizer.js';
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
const NA = '不适用';

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function llmParameterizeWorkout(
  args: LlmParameterizeArgs,
): Promise<LlmParameterizeResult> {
  const { template, athleteProfile, recentState, request, scheduleEntry, progression } = args;

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
            durationMinutes: { type: 'integer', minimum: 0, maximum: 360 },
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
  });

  const stream = await streamChat({
    messages,
    tools,
    toolChoice: { type: 'function', function: { name: TOOL_NAME } },
    temperature: 0.5,
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
    progression,
  });

  return {
    workout,
    meta: { inputTokens, outputTokens },
  };
}

// ---------------------------------------------------------------------------
// Validation + assembly
// ---------------------------------------------------------------------------

interface ValidateBuildArgs {
  parsed: LlmWorkoutPayload;
  template: WorkoutTemplate;
  request: LlmParameterizeArgs['request'];
  progression: 'conservative' | 'normal' | 'aggressive';
}

function validateAndBuild(args: ValidateBuildArgs): ParameterizedWorkout {
  const violations: string[] = [];
  const { parsed, template, request, progression } = args;
  const sport = template.fixed.sport;

  const parsedDurationMinutes = Number.isFinite(parsed.durationMinutes)
    ? Math.max(0, Math.round(parsed.durationMinutes ?? 0))
    : 0;
  const durationMinutes = applyPreferredDuration(
    template,
    parsedDurationMinutes,
    request.dailyPreferredMinutes ?? null,
  );

  // Distance.
  const distanceKm =
    typeof parsed.distanceKm === 'number' && Number.isFinite(parsed.distanceKm)
      ? Math.round(parsed.distanceKm * 100) / 100
      : null;

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
    ? parsed.targets.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    : [];

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
): number {
  if (
    preferredMinutes === null ||
    !Number.isFinite(preferredMinutes) ||
    preferredMinutes <= 0 ||
    template.fixed.sport === 'rest' ||
    template.fixed.sport === 'mobility' ||
    durationMinutes <= 0
  ) {
    return durationMinutes;
  }
  const lower = Math.max(15, template.fixed.minDurationMinutes);
  const upper = Math.max(lower, template.fixed.maxDurationMinutes);
  return Math.min(upper, Math.max(lower, Math.round(preferredMinutes)));
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
  systemParts.push(
    `- 当前 progression=${args.progression}，对照模板的 progression 调整时长和重复次数。`,
  );
  if (args.request.dailyPreferredMinutes && args.request.dailyPreferredMinutes > 0) {
    systemParts.push(
      `- 用户填写了每日偏好时长 ${args.request.dailyPreferredMinutes} 分钟；非休息/恢复课的总时长应尽量接近该值，同时不得超出模板 min/max。`,
    );
  }
  if (args.request.availableTime) {
    systemParts.push(`- 用户可用时间说明：${args.request.availableTime}`);
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
