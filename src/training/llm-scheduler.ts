// LLM-driven 7-day scheduler (U9).
//
// Pre-screens templates per-sport with U5's filterAllowedTemplates so the LLM
// only sees IDs that pass hard contraindications, then asks the model to pick
// one templateId per dayIndex via a tool call. Output is validated; on failure
// the caller (orchestrator) falls back to U7's deterministic
// buildWeeklySchedule.
//
// Provider-agnostic: relies entirely on the OpenAI SDK pointed at whatever
// baseURL the active llm_config row supplies (DeepSeek, Qwen, OpenAI, …).

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
import {
  filterAllowedTemplates,
  getCatalogForPrompt,
  getTemplate,
  WORKOUT_TEMPLATES,
  type Sport,
} from './templates/index.js';
import type { AthleteProfile } from './athlete-profile.js';
import type { RecentState } from './recent-state.js';
import type {
  ActiveSport,
  ScheduleEntry,
  ScheduleRequest,
  ScheduleResult,
} from './scheduler.js';
import {
  applyDurationCap,
  formatDayIndexes,
  MAX_WEEKLY_TRAINING_MINUTES,
  normalizeDaysPerWeek,
  requestedDoubleDayIndex,
  requestedTrainingDayIndexes,
} from './scheduler.js';
import type { TrainingCapacity } from './training-capacity.js';
import {
  extractTrainingRequestIntent,
  formatTrainingIntentForPrompt,
  isTemplateEnabledByRequest,
} from './request-intent.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class LlmNotConfiguredError extends Error {
  constructor(message = 'No active LLM config') {
    super(message);
    this.name = 'LlmNotConfiguredError';
  }
}

export class InvalidLlmScheduleError extends Error {
  readonly violations: string[];
  constructor(violations: string[]) {
    super(`LLM schedule invalid: ${violations.join('; ')}`);
    this.name = 'InvalidLlmScheduleError';
    this.violations = violations;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LlmBuildScheduleArgs {
  request: ScheduleRequest;
  athleteProfile: AthleteProfile;
  isColdStart?: boolean;
  recentState: RecentState;
  trainingCapacity?: TrainingCapacity;
  signal?: AbortSignal;
  /** Extra system-prompt text to inject after a previous failed attempt. */
  retryViolations?: string[];
}

export interface LlmScheduleMeta {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmBuildScheduleResult {
  schedule: ScheduleResult;
  meta: LlmScheduleMeta;
}

interface LlmDay {
  dayIndex: number;
  slotIndex?: number;
  sessionLabel?: string;
  timeOfDay?: ScheduleEntry['timeOfDay'];
  sport: string;
  templateId: string;
  reason?: string;
}

interface LlmToolPayload {
  days: LlmDay[];
  notes?: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAY_LABELS: readonly string[] = [
  '周一', '周二', '周三', '周四', '周五', '周六', '周日',
];

const ALLOWED_SPORTS: ReadonlySet<string> = new Set([
  'running', 'cycling', 'swimming', 'rest', 'mobility', 'strength',
]);

const TOOL_NAME = 'select_weekly_schedule';
const SCHEDULE_TOOL_CALL_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function llmBuildWeeklySchedule(
  args: LlmBuildScheduleArgs,
): Promise<LlmBuildScheduleResult> {
  // Probe active config first so absence is a typed error.
  let config;
  try {
    config = await getActiveLlmConfig();
  } catch (err) {
    throw new LlmNotConfiguredError((err as Error).message);
  }

  const { request, athleteProfile, recentState, trainingCapacity } = args;
  const isColdStart = args.isColdStart ?? false;
  const requestIntent = extractTrainingRequestIntent(request);
  const effectiveHardCap = computeHardCap(
    request,
    athleteProfile,
    recentState,
    trainingCapacity,
  );

  // Build per-sport allowed catalog (post-contraindication filter).
  const enabledSports = collectEnabledSports(request);
  const requestedTrainingDays = effectiveTrainingDaysPerWeek(request);
  const allowedIds = new Set<string>();
  const catalogLines: string[] = [];

  for (const sport of enabledSports) {
    const allowed = filterAllowedTemplates({
      sport,
      athleteProfile: filterAthleteProfile(
        athleteProfile,
        request.forceRequestedSchedule === true,
      ),
      recentState: filterRecentState(
        recentState,
        request.forceRequestedSchedule === true,
      ),
      request: {
        sports: request.sports as Partial<Record<Sport, boolean>>,
        maxHardSessionsPerWeek: effectiveHardCap,
        allowAdvancedWorkouts:
          request.allowAdvancedWorkouts === true || request.forceRequestedSchedule === true,
      },
      hardSessionsAlreadyScheduledThisWeek: 0,
    });
    for (const tpl of allowed) allowedIds.add(tpl.id);
    const catalog = getCatalogForPrompt([sport]);
    if (catalog) {
      // Filter the catalog rows down to just the allowed ones for this sport.
      const allowedSet = new Set(allowed.map((t) => t.id));
      catalogLines.push(
        catalog
          .split('\n')
          .filter((line) => {
            const id = line.split(' | ')[0]?.trim();
            return id ? allowedSet.has(id) : false;
          })
          .join('\n'),
      );
    }
  }

  // Allow rest templates only when the requested training frequency leaves
  // actual rest/recovery days. A 7-day request must not silently become a
  // 6-day plan plus one rest day.
  if (requestedTrainingDays < 7) {
    for (const tpl of Object.values(WORKOUT_TEMPLATES)) {
      if (tpl.fixed.sport === 'rest' || tpl.fixed.sport === 'mobility') {
        allowedIds.add(tpl.id);
      }
    }
    const restCatalog = getCatalogForPrompt(['rest', 'mobility']);
    if (restCatalog) catalogLines.push(restCatalog);
  }

  for (const required of requestIntent.requiredWorkouts) {
    const tpl = getTemplate(required.templateId);
    if (!tpl || !isTemplateEnabledByRequest(required.templateId, request)) continue;
    allowedIds.add(required.templateId);
    const line = catalogLineForTemplate(required.templateId);
    if (line) catalogLines.push(line);
  }

  const messages = buildMessages({
    request,
    athleteProfile,
    isColdStart,
    recentState,
    trainingCapacity,
    requestIntent,
    catalog: catalogLines.join('\n'),
    retryViolations: args.retryViolations,
  });

  const tools: ChatCompletionTool[] = [
    {
      type: 'function',
      function: {
        name: TOOL_NAME,
        description:
          '从允许的模板列表中为本周训练日程选择 templateId，并附中文 reason。默认每个 dayIndex 1 个；用户明确要求一天两练时，可为同一 dayIndex 返回 slotIndex=1/2 两条。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['days'],
          properties: {
            days: {
              type: 'array',
              minItems: 7,
              maxItems: args.request.allowDoubleDays === true ? 10 : 7,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['dayIndex', 'sport', 'templateId', 'reason'],
                properties: {
                  dayIndex: { type: 'integer', minimum: 1, maximum: 7 },
                  slotIndex: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 3,
                    description: '同一天多课时的课次编号；单练可省略或填 1',
                  },
                  sessionLabel: {
                    type: 'string',
                    description: '例如 上午 / 下午；单练可省略',
                  },
                  timeOfDay: {
                    type: 'string',
                    enum: ['morning', 'midday', 'afternoon', 'evening'],
                  },
                  sport: {
                    type: 'string',
                    enum: ['running', 'cycling', 'swimming', 'rest', 'mobility', 'strength'],
                  },
                  templateId: { type: 'string' },
                  reason: { type: 'string', description: '中文一行说明' },
                },
              },
            },
            notes: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
      },
    },
  ];

  if (shouldUseNonStreamingToolCalls(config)) {
    const completion = await completeChat({
      messages,
      tools,
      toolChoice: { type: 'function', function: { name: TOOL_NAME } },
      temperature: 0.4,
      timeoutMs: SCHEDULE_TOOL_CALL_TIMEOUT_MS,
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
      throw new InvalidLlmScheduleError(['model did not emit tool call']);
    }

    let parsed: LlmToolPayload;
    try {
      parsed = JSON.parse(argsBuffer) as LlmToolPayload;
    } catch (err) {
      throw new InvalidLlmScheduleError([
        `JSON parse failed: ${(err as Error).message}`,
      ]);
    }

    const validated = validateAndBuildResult({
      parsed,
      request,
      allowedIds,
      athleteProfile,
      recentState,
      trainingCapacity,
    });

    return {
      schedule: validated,
      meta: {
        provider: config.name,
        model: config.model,
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
      },
    };
  }

  // Stream + accumulate tool-call argument deltas. Most OpenAI-compatible
  // providers emit the tool args as a series of `delta.tool_calls[i].function
  // .arguments` JSON-fragment strings; we concat then JSON.parse once at the end.
  const stream = await streamChat({
    messages,
    tools,
    toolChoice: { type: 'function', function: { name: TOOL_NAME } },
    temperature: 0.4,
    timeoutMs: SCHEDULE_TOOL_CALL_TIMEOUT_MS,
    signal: args.signal,
  });

  // OpenAI's streaming format keys tool-call args by `index`. Some providers
  // emit a leading {index, id, function:{name}} chunk with empty args, then
  // {index, function:{arguments:"..."}} bursts. Multi-tool-call-capable
  // providers can interleave indices. Concatenate per-index, then take the
  // first slot in arrival order — `toolChoice` forces a single function so
  // there's no ambiguity in practice, but this protects against drift.
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
    // Some providers (OpenAI-compatible) include usage in the final chunk.
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
    throw new InvalidLlmScheduleError(['model did not emit tool call']);
  }

  let parsed: LlmToolPayload;
  try {
    parsed = JSON.parse(argsBuffer) as LlmToolPayload;
  } catch (err) {
    throw new InvalidLlmScheduleError([
      `JSON parse failed: ${(err as Error).message}`,
    ]);
  }

  // Validate.
  const validated = validateAndBuildResult({
    parsed,
    request,
    allowedIds,
    athleteProfile,
    recentState,
    trainingCapacity,
  });

  return {
    schedule: validated,
    meta: {
      provider: config.name,
      model: config.model,
      inputTokens,
      outputTokens,
    },
  };
}

// ---------------------------------------------------------------------------
// Validation + assembly
// ---------------------------------------------------------------------------

interface ValidateArgs {
  parsed: LlmToolPayload;
  request: ScheduleRequest;
  allowedIds: Set<string>;
  athleteProfile: AthleteProfile;
  recentState: RecentState;
  trainingCapacity?: TrainingCapacity;
}

function validateAndBuildResult(args: ValidateArgs): ScheduleResult {
  const violations: string[] = [];
  const { parsed, request, allowedIds, athleteProfile, recentState, trainingCapacity } = args;

  if (!Array.isArray(parsed.days)) {
    throw new InvalidLlmScheduleError(['days is not an array']);
  }
  const allowDoubleDays = request.allowDoubleDays === true;
  if (allowDoubleDays) {
    if (parsed.days.length < 7 || parsed.days.length > 10) {
      violations.push(`days.length=${parsed.days.length}, expected 7..10 when double days are allowed`);
    }
  } else if (parsed.days.length !== 7) {
    violations.push(`days.length=${parsed.days.length}, expected 7`);
  }

  const seenSlotsByDay = new Map<number, Set<number>>();
  const entries: ScheduleEntry[] = [];

  for (const day of parsed.days) {
    if (
      typeof day.dayIndex !== 'number' ||
      day.dayIndex < 1 ||
      day.dayIndex > 7 ||
      !Number.isInteger(day.dayIndex)
    ) {
      violations.push(`invalid dayIndex: ${String(day.dayIndex)}`);
      continue;
    }
    const usedSlots = seenSlotsByDay.get(day.dayIndex) ?? new Set<number>();
    let slotIndex = typeof day.slotIndex === 'number' && Number.isInteger(day.slotIndex)
      ? day.slotIndex
      : 1;
    if (usedSlots.has(slotIndex) && allowDoubleDays) {
      slotIndex = firstAvailableSlot(usedSlots);
    }
    if (slotIndex < 1 || slotIndex > 3) {
      violations.push(`day ${day.dayIndex}: invalid slotIndex ${String(day.slotIndex)}`);
      continue;
    }
    if (usedSlots.has(slotIndex)) {
      violations.push(`duplicate dayIndex ${day.dayIndex} slotIndex ${slotIndex}`);
      continue;
    }
    if (!allowDoubleDays && usedSlots.size > 0) {
      violations.push(`duplicate dayIndex ${day.dayIndex}`);
      continue;
    }
    usedSlots.add(slotIndex);
    seenSlotsByDay.set(day.dayIndex, usedSlots);

    if (typeof day.sport !== 'string' || !ALLOWED_SPORTS.has(day.sport)) {
      violations.push(`day ${day.dayIndex}: invalid sport "${String(day.sport)}"`);
      continue;
    }
    if (typeof day.templateId !== 'string' || day.templateId.length === 0) {
      violations.push(`day ${day.dayIndex}: missing templateId`);
      continue;
    }

    const tpl = getTemplate(day.templateId);
    if (!tpl) {
      violations.push(
        `day ${day.dayIndex}: unknown templateId "${day.templateId}"`,
      );
      continue;
    }

    if (tpl.fixed.sport !== day.sport && !areCompatibleRestLikeSports(tpl.fixed.sport, day.sport)) {
      violations.push(
        `day ${day.dayIndex}: template ${day.templateId} sport=${tpl.fixed.sport} != claimed sport=${day.sport}`,
      );
      continue;
    }

    // Re-check filter for the template's actual sport. This catches any
    // template the LLM picked outside the catalog or that contraindications
    // would block now.
    if (
      !allowedIds.has(day.templateId) &&
      !(request.forceRequestedSchedule === true && isTemplateEnabledByRequest(day.templateId, request))
    ) {
      violations.push(
        `day ${day.dayIndex}: template ${day.templateId} not in allowed catalog`,
      );
      continue;
    }

    const entry: ScheduleEntry = {
      dayIndex: day.dayIndex,
      date: addDays(request.weekStartDate, day.dayIndex - 1),
      dayLabel: DAY_LABELS[day.dayIndex - 1] ?? '',
      sport: tpl.fixed.sport,
      templateId: day.templateId,
      slotIndex,
      sessionLabel: typeof day.sessionLabel === 'string' ? day.sessionLabel : undefined,
      timeOfDay: day.timeOfDay ?? chooseTimeOfDay(request, day.dayIndex),
      reason: typeof day.reason === 'string' ? day.reason : undefined,
    };
    applyDurationCap(entry, request.forceRequestedSchedule ? undefined : trainingCapacity);
    entries.push(entry);
  }

  if (!allowDoubleDays && entries.length !== 7) {
    violations.push(`only ${entries.length}/7 days valid`);
  }
  const coveredDayIndexes = new Set(entries.map((e) => e.dayIndex));
  if (coveredDayIndexes.size !== 7) {
    violations.push(`covered dayIndex count ${coveredDayIndexes.size} != 7`);
  }

  // Hard-rule: no two consecutive intensity=high.
  const sortedEntries = entries
    .slice()
    .sort((a, b) => a.dayIndex - b.dayIndex || (a.slotIndex ?? 1) - (b.slotIndex ?? 1));
  const requestedTrainingDays = effectiveTrainingDaysPerWeek(request);
  const protectedTrainingDays = requestedTrainingDayIndexes(request);
  const enabledSports = collectEnabledSports(request);
  const preferredMinutes =
    request.dailyPreferredMinutes !== null &&
    request.dailyPreferredMinutes !== undefined &&
    Number.isFinite(request.dailyPreferredMinutes)
      ? request.dailyPreferredMinutes
      : null;
  if (preferredMinutes !== null && preferredMinutes < 70) {
    for (const entry of sortedEntries) {
      if (entry.templateId === 'run.lsd.v1') {
        violations.push(`day ${entry.dayIndex}: run.lsd.v1 requires at least 70 minutes; use run.aerobic.v1/recovery under ${preferredMinutes} minutes`);
      }
    }
  }
  if (preferredMinutes !== null && preferredMinutes < 25) {
    for (const entry of sortedEntries) {
      if (entry.templateId.startsWith('run.') && entry.templateId !== 'run.recovery.v1') {
        violations.push(`day ${entry.dayIndex}: short running window should use run.recovery.v1, not ${entry.templateId}`);
      }
    }
  }
  if (preferredMinutes !== null && preferredMinutes < 30) {
    for (const entry of sortedEntries) {
      if (entry.templateId.startsWith('swim.') && entry.templateId !== 'swim.recovery.v1') {
        violations.push(`day ${entry.dayIndex}: short swim window should use swim.recovery.v1, not ${entry.templateId}`);
      }
      if (entry.templateId.startsWith('bike.') && entry.templateId !== 'bike.recovery_spin.v1') {
        violations.push(`day ${entry.dayIndex}: short bike window should use bike.recovery_spin.v1, not ${entry.templateId}`);
      }
    }
  }
  if (preferredMinutes !== null && preferredMinutes < 90) {
    for (const entry of sortedEntries) {
      if (entry.templateId === 'bike.long_ride.v1') {
        violations.push(`day ${entry.dayIndex}: bike.long_ride.v1 requires at least 90 minutes; use bike.endurance.v1/recovery under ${preferredMinutes} minutes`);
      }
    }
  }
  const activeTrainingCount = new Set(
    sortedEntries
      .filter((e) => !isRestLikeSport(e.sport))
      .map((e) => e.dayIndex),
  ).size;
  if (activeTrainingCount !== requestedTrainingDays) {
    violations.push(
      `active training days ${activeTrainingCount} != requested daysPerWeek ${requestedTrainingDays}`,
    );
  }
  if (requestedTrainingDays === 7) {
    const restLike = sortedEntries.filter((e) => isRestLikeSport(e.sport));
    if (restLike.length > 0) {
      violations.push(
        `daysPerWeek=7 but rest/mobility days found: ${restLike.map((e) => e.dayIndex).join(',')}`,
      );
    }
  }
  for (const protectedDay of protectedTrainingDays) {
    const dayEntries = sortedEntries.filter((e) => e.dayIndex === protectedDay);
    if (dayEntries.length === 0 || dayEntries.every((e) => isRestLikeSport(e.sport))) {
      violations.push(`day ${protectedDay}: user requested training but model scheduled rest/mobility`);
    }
  }

  if (allowDoubleDays) {
    const allowSameSportDouble = hasExplicitSameSportDoubleRequest(request);
    for (const dayIndex of coveredDayIndexes) {
      const dayEntries = sortedEntries.filter((e) => e.dayIndex === dayIndex);
      if (dayEntries.length < 2) continue;
      const activeEntries = dayEntries.filter((e) => !isRestLikeSport(e.sport));
      const templateIds = activeEntries.map((e) => e.templateId);
      if (!allowSameSportDouble && new Set(templateIds).size < templateIds.length) {
        violations.push(`day ${dayIndex}: repeated templateId in double day`);
      }
      const activeSports = new Set(activeEntries.map((e) => e.sport));
      if (
        !allowSameSportDouble &&
        enabledSports.length > 1 &&
        activeEntries.length > 1 &&
        activeSports.size < activeEntries.length
      ) {
        violations.push(`day ${dayIndex}: double day repeats ${Array.from(activeSports).join('/')} instead of cross-training`);
      }
    }
  }

  if (request.daysPerWeek >= enabledSports.length) {
    for (const sport of enabledSports) {
      if (!sortedEntries.some((e) => e.sport === sport)) {
        violations.push(`${sport}: enabled but not scheduled this week`);
      }
    }
  }

  if (request.forceRequestedSchedule !== true) {
    for (let i = 1; i < sortedEntries.length; i += 1) {
      const prev = sortedEntries[i - 1];
      const curr = sortedEntries[i];
      if (
        prev.dayIndex + 1 === curr.dayIndex &&
        getTemplate(prev.templateId)?.fixed.intensity === 'high' &&
        getTemplate(curr.templateId)?.fixed.intensity === 'high'
      ) {
        violations.push(
          `days ${prev.dayIndex}/${curr.dayIndex}: consecutive high-intensity`,
        );
      }
    }
  }

  // Hard-rule: hard-cap.
  const HARD_STIMULI = new Set(['threshold', 'vo2max', 'anaerobic']);
  const hardCap = computeHardCap(request, athleteProfile, recentState, trainingCapacity);
  const hardCount = sortedEntries.filter(
    (e) => getTemplate(e.templateId)?.fixed.intensity === 'high',
  ).length;
  if (request.forceRequestedSchedule !== true && hardCount > hardCap) {
    violations.push(`hard count ${hardCount} > cap ${hardCap}`);
  }

  // Quality sessions should have distinct training purposes when the allowed
  // catalog gives the model alternatives. The LLM still chooses the mix; this
  // only rejects duplicated high-intensity templates when variety is possible.
  if (request.forceRequestedSchedule !== true) {
    for (const sport of ['running', 'cycling', 'swimming']) {
      const pickedHigh = sortedEntries.filter((e) => {
        const tpl = getTemplate(e.templateId);
        return tpl?.fixed.sport === sport && tpl.fixed.intensity === 'high';
      });
      if (pickedHigh.length < 2) continue;
      const pickedIds = new Set(pickedHigh.map((e) => e.templateId));
      const allowedHighAlternatives = Array.from(allowedIds).filter((id) => {
        const tpl = getTemplate(id);
        return tpl?.fixed.sport === sport && tpl.fixed.intensity === 'high';
      });
      if (
        pickedIds.size < pickedHigh.length &&
        allowedHighAlternatives.length > pickedIds.size
      ) {
        violations.push(
          `${sport}: repeated high-intensity template despite available alternatives`,
        );
      }
    }
  }

  // Hard-rule: no high intensity within 36h of a recent threshold/vo2/anaerobic.
  const hoursAgo = hoursSinceLatest(recentState);
  if (
    request.forceRequestedSchedule !== true &&
    HARD_STIMULI.has(recentState.latestStimulus) &&
    hoursAgo !== null &&
    hoursAgo < 36
  ) {
    const day1 = sortedEntries.find((e) => e.dayIndex === 1);
    if (day1 && getTemplate(day1.templateId)?.fixed.intensity === 'high') {
      violations.push(
        `day 1 high-intensity but recent ${recentState.latestStimulus} was ${Math.round(hoursAgo)}h ago`,
      );
    }
  }

  if (violations.length > 0) {
    throw new InvalidLlmScheduleError(violations);
  }

  const notes: string[] = [];
  if (Array.isArray(parsed.notes)) {
    for (const n of parsed.notes) {
      if (typeof n === 'string' && n.trim().length > 0) notes.push(n.trim());
    }
  }

  return {
    days: sortedEntries,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

interface BuildMessagesArgs {
  request: ScheduleRequest;
  athleteProfile: AthleteProfile;
  isColdStart: boolean;
  recentState: RecentState;
  trainingCapacity?: TrainingCapacity;
  requestIntent: ReturnType<typeof extractTrainingRequestIntent>;
  catalog: string;
  retryViolations?: string[];
}

function buildMessages(args: BuildMessagesArgs): ChatCompletionMessageParam[] {
  const systemParts: string[] = [];
  systemParts.push(
    '你是一位专业的运动教练，正在为用户安排 7 天训练计划。所有训练动作只能从下列允许的模板中选择 templateId，不允许编造模板 id 或参数。',
  );
  systemParts.push(
    '最高优先级：用户明确写出的训练类型、训练天数、同日多练和周目标时长优先于健康保护规则；如果存在风险，只能在 notes 中提醒，不要擅自删除或替换用户明确要求的训练。',
  );
  systemParts.push('用户显式意图：');
  systemParts.push(formatTrainingIntentForPrompt(args.requestIntent));
  systemParts.push(
    '硬性规则：',
  );
  const requestedTrainingDays = effectiveTrainingDaysPerWeek(args.request);
  const requestedRestDays = 7 - requestedTrainingDays;
  const requestedDoubleDay = requestedDoubleDayIndex(args.request);
  const allowExtraSlots =
    args.request.allowDoubleDays === true &&
    (requestedDoubleDay !== null ||
      shouldUseDoubleDaysForDurationTarget(
        args.request,
        args.requestIntent.weeklyTargetMinutes,
        requestedTrainingDays,
      ));
  const protectedTrainingDays = requestedTrainingDayIndexes(args.request);
  if (allowExtraSlots) {
    systemParts.push(
      '- 必须覆盖 7 个 dayIndex (1..7)；允许为了满足同日多练或平均训练时长目标让 days 数组超过 7 条，同一 dayIndex 用 slotIndex=1/2 表示上午/下午两课。加练优先使用低强度 Z2、有氧、恢复或技术模板。',
    );
    systemParts.push(
      '- 当用户开启多个运动项目时，非明确“双阈值/同项目两练”请求下，同一天第二练应优先安排跨项目低压力恢复或技术训练；禁止用同一 sport 或同一 templateId 重复堆普通有氧。',
    );
  } else {
    systemParts.push('- 必须输出且仅输出 7 条，覆盖 dayIndex 1..7；');
  }
  systemParts.push(
    `- 用户选择每周 ${requestedTrainingDays} 天训练：必须正好 ${requestedTrainingDays} 天使用 running/cycling/swimming 模板，剩余 ${requestedRestDays} 天才可使用 rest/mobility 模板；`,
  );
  if (protectedTrainingDays.size > 0) {
    systemParts.push(
      `- 用户明确指定 ${formatDayIndexes(protectedTrainingDays)} 为训练日：这些 dayIndex 禁止使用 rest/mobility 模板，也不能被默认休息日、近期疲劳或容量保护改成休息。`,
    );
  }
  if (requestedTrainingDays === 7) {
    systemParts.push(
      '- 用户选择每周 7 天训练：禁止使用 rest 或 mobility 模板，7 天都必须是实际运动训练；恢复只能用各运动项目的低强度恢复模板。',
    );
  }
  systemParts.push('- 每个非休息日必须给出一个允许列表中的 templateId；');
  if (args.request.forceRequestedSchedule !== true) {
    systemParts.push('- 任意相邻两天不得同时为 intensity=high 的训练；');
  } else {
    systemParts.push(
      '- 严格模式已开启：不要因为连续高强度、近期训练刺激或容量评估自动减少用户要求的训练天数/强度；这些问题只在 notes 中写成风险提示。',
    );
  }
  systemParts.push(
    `- 专业建议：本周高强度课建议不超过 ${computeHardCap(
      args.request,
      args.athleteProfile,
      args.recentState,
      args.trainingCapacity,
    )} 次；如果用户显式要求超过，只能提示风险，不能删除用户要求。`,
  );
  if (
    args.request.maxHardSessionsPerWeek !== null &&
    args.request.maxHardSessionsPerWeek !== undefined
  ) {
    const hardLine = args.request.forceRequestedSchedule === true
      ? `- 用户选择每周 ${args.request.maxHardSessionsPerWeek} 次高强度，这是严格模式下的目标次数；训练天数足够且允许高级训练时，应安排到这个次数。除非用户文字明确点名更多具体高强度课，否则不得超过这个次数。`
      : `- 用户设置的每周高强度上限为 ${args.request.maxHardSessionsPerWeek} 次，这是用户要求；除非用户文字明确点名更多具体高强度课，否则不得超过这个次数。`;
    systemParts.push(hardLine);
  }
  if (args.request.forceRequestedSchedule !== true) {
    systemParts.push(
      '- 若最近 36 小时内有 threshold/vo2max/anaerobic 训练，第 1 天不得安排高强度课；',
    );
  }
  systemParts.push(
    `- 本周总训练时长不得超过 ${args.request.weeklyMaxMinutes ?? MAX_WEEKLY_TRAINING_MINUTES} 分钟；`,
  );
  if (args.requestIntent.weeklyTargetMinutes !== null) {
    systemParts.push(
      `- 用户写明本周训练目标约 ${args.requestIntent.weeklyTargetMinutes} 分钟：在不超过周上限的前提下，应尽量接近该目标；优先增加 Z2、长距离、恢复和技术训练时长，质量课只增加热身/放松或恢复段。`,
    );
  }
  systemParts.push(
    '- sport 字段必须与所选 templateId 对应模板的 sport 一致；',
  );
  if (requestedTrainingDays < 7) {
    systemParts.push(
      '- 休息日请使用 rest 类模板（rest.full.v1 / rest.mobility.v1）。',
    );
  }
  systemParts.push(
    '- 同一运动一周内若安排多次 high 强度课，应优先覆盖不同训练目的，例如 threshold / interval / VO2max / race_pace，不要无理由重复同一个 high 模板；',
  );
  systemParts.push(
    '- 跑步用户若一周有 2 次质量课，通常一节偏阈值/节奏，一节偏间歇/VO2max，除非近期疲劳或模板禁忌不允许；',
  );
  systemParts.push(
    '- 如果用户同时启用游泳、骑行、跑步，并且训练天数足够，每周必须同时覆盖三项；不要只围绕跑步安排。',
  );
  systemParts.push(
    '- 骑行有 FTP 时优先选择/输出功率目标；游泳优先使用 CSS/每 100m 配速；跑步低强度优先心率区间。',
  );
  if (args.request.dailyPreferredMinutes && args.request.dailyPreferredMinutes > 0) {
    systemParts.push(
      `- 用户填写的 ${args.request.dailyPreferredMinutes} 分钟是训练日平均时长参考，不是单节硬上限；整体课表应让训练日平均时长接近该值。低强度 Z2/有氧/长距离课可以超过该值，高级用户的 Z2 骑行通常不应短于 75-90 分钟。不要为了凑时长拉长阈值/VO2/间歇主训练。`,
    );
    systemParts.push(
      '- 如果该时长低于长距离模板的最低可执行时长，不要把普通有氧课标成 long/LSD：跑步 run.lsd.v1 至少需要 70 分钟，骑行 bike.long_ride.v1 至少需要 90 分钟；更短时使用 aerobic/endurance/recovery 模板。',
    );
    if (args.request.dailyPreferredMinutes < 30) {
      systemParts.push(
        '- 用户单日时长非常短：优先使用 recovery/technique 模板，不要安排常规有氧、长距离或复杂质量课来硬塞进短窗口。',
      );
    }
  }
  if (args.isColdStart) {
    systemParts.push(
      '- 该用户结构化训练历史很少或暂无可用运动能力档案；本周日程必须保守，优先低强度、有氧基础、技术和恢复，不要安排激进配速/功率导向的高风险结构。',
    );
  }
  if (args.trainingCapacity) {
    systemParts.push(
      `- 训练容量评估：level=${args.trainingCapacity.overall.level}, readiness=${args.trainingCapacity.overall.readiness}, confidence=${args.trainingCapacity.overall.readinessConfidence}，高强度上限 ${args.trainingCapacity.guardrails.maxHardSessionsPerWeek} 次，高强度分钟占比上限 ${Math.round(args.trainingCapacity.guardrails.maxHighMinutesShare * 100)}%。`,
    );
    systemParts.push(
      '- 单周专业规则：低强度训练应占主体；不要用多个长阈值/VO2/间歇课去填满用户可用时长；长跑/长骑只能作为本项目周训练量的一部分，不能吞掉大多数训练分钟。',
    );
    if (args.request.forceRequestedSchedule === true) {
      systemParts.push(
        '- 用户已明确要求按原请求生成：不要因为训练容量保护自动删除用户要求的训练频率/高强度意图，但必须在 notes 中说明风险与不推荐原因。',
      );
    } else if (!args.trainingCapacity.guardrails.allowHighIntensity) {
      systemParts.push(
        '- 容量/恢复保护：本周禁止安排 intensity=high 的模板，只能安排低强度、技术或恢复类训练。',
      );
    }
  }
  if (args.request.preferredTrainingWindows && args.request.preferredTrainingWindows.length > 0) {
    systemParts.push(
      `- 用户偏好训练时段：${args.request.preferredTrainingWindows.join('、')}；调度结果会按这些时段标注 timeOfDay。`,
    );
  }
  if (args.request.allowAdvancedWorkouts !== true) {
    if (args.request.forceRequestedSchedule === true && args.requestIntent.requiredWorkouts.length > 0) {
      systemParts.push(
        '- 用户未开启高级训练开关，但文字里显式要求了高级训练；本次以文字要求为准，安排对应模板并在 notes 中提示风险。',
      );
    } else {
      systemParts.push(
        '- 用户未开启高级训练：不得安排 VO2max、短间歇、无氧、冲刺、坡跑/爬坡、比赛专项、公开水域专项、双阈值或同日多练。',
      );
    }
  } else {
    systemParts.push(
      '- 用户已开启高级训练：如果用户点名高级模板必须安排；未点名的高级模板仍需根据训练基础、疲劳、禁忌和高强度上限谨慎选择。',
    );
  }
  systemParts.push('');
  systemParts.push('允许的模板列表（每行格式：id | sport | intensity | purpose | block:contraindications）：');
  systemParts.push(args.catalog || '(空)');

  if (args.retryViolations && args.retryViolations.length > 0) {
    systemParts.push('');
    systemParts.push('上一次输出违反规则，请重新规划，避免下列问题：');
    for (const v of args.retryViolations) {
      systemParts.push(`- ${v}`);
    }
  }

  const user = {
    weekStartDate: args.request.weekStartDate,
    goal: args.request.goal ?? null,
    raceDate: args.request.raceDate ?? null,
    goalDistance: args.request.goalDistance ?? null,
    daysPerWeek: args.request.daysPerWeek,
    preferredRestDay: args.request.preferredRestDay ?? null,
    availableTime: args.request.availableTime ?? null,
    preferredTrainingWindows: args.request.preferredTrainingWindows ?? [],
    preferredKeyWorkoutDays: args.request.preferredKeyWorkoutDays ?? [],
    dailyPreferredMinutes: args.request.dailyPreferredMinutes ?? null,
    weeklyMaxMinutes: args.request.weeklyMaxMinutes ?? MAX_WEEKLY_TRAINING_MINUTES,
    injuries: args.request.injuries ?? null,
    notes: args.request.notes ?? null,
    sports: args.request.sports,
    sportPriorities: args.request.sportPriorities ?? null,
    maxHardSessionsPerWeek: args.request.maxHardSessionsPerWeek,
    targetMetricPreference: args.request.targetMetricPreference,
    isColdStart: args.isColdStart,
    athleteProfile: {
      experienceLevel: args.athleteProfile.experienceLevel,
      heartRate: args.athleteProfile.heartRate,
      running: args.athleteProfile.running,
      cycling: {
        available: args.athleteProfile.cycling.available,
        confidence: args.athleteProfile.cycling.confidence,
        ftpWatts: args.athleteProfile.cycling.ftpWatts ?? null,
      },
      swimming: args.athleteProfile.swimming,
      injuries: args.athleteProfile.injuries,
    },
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
      content: `请为以下用户规划本周训练并通过 ${TOOL_NAME} 工具返回。\n\n${JSON.stringify(user, null, 2)}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectEnabledSports(request: ScheduleRequest): ActiveSport[] {
  const out: ActiveSport[] = [];
  if (request.sports.running) out.push('running');
  if (request.sports.cycling) out.push('cycling');
  if (request.sports.swimming) out.push('swimming');
  return out;
}

function hasExplicitSameSportDoubleRequest(request: ScheduleRequest): boolean {
  const text = [
    request.goal,
    request.availableTime,
    request.notes,
    ...(request.preferredTrainingWindows ?? []),
  ]
    .filter(Boolean)
    .join('\n');
  return /双阈值|双阈|同项目.*两练|两练.*同项目|一天.*两.*跑|一天.*两.*骑|一天.*两.*游|double\s*threshold|same[-\s]?sport/i.test(text);
}

function catalogLineForTemplate(templateId: string): string | null {
  const tpl = getTemplate(templateId);
  if (!tpl) return null;
  const purpose =
    tpl.fixed.purpose.length <= 40 ? tpl.fixed.purpose : `${tpl.fixed.purpose.slice(0, 39)}…`;
  const block = tpl.fixed.contraindications.length
    ? tpl.fixed.contraindications.slice(0, 3).join(',')
    : 'none';
  return `${tpl.id} | ${tpl.fixed.sport} | ${tpl.fixed.intensity} | ${purpose} | block:${block}`;
}

function firstAvailableSlot(usedSlots: Set<number>): number {
  for (const slot of [1, 2, 3]) {
    if (!usedSlots.has(slot)) return slot;
  }
  return 4;
}

function chooseTimeOfDay(
  request: ScheduleRequest,
  dayIndex: number,
): ScheduleEntry['timeOfDay'] | undefined {
  const windows = request.preferredTrainingWindows ?? [];
  if (windows.length === 0) return undefined;
  return parseTrainingWindow(windows[(dayIndex - 1) % windows.length] ?? '');
}

function parseTrainingWindow(raw: string): ScheduleEntry['timeOfDay'] | undefined {
  const value = raw.trim().toLowerCase();
  if (!value) return undefined;
  if (/早|晨|上午|morning|am|a\.m\./i.test(value)) return 'morning';
  if (/中午|午间|midday|noon/i.test(value)) return 'midday';
  if (/下午|afternoon|pm|p\.m\./i.test(value)) return 'afternoon';
  if (/晚|夜|evening|night/i.test(value)) return 'evening';
  return undefined;
}

function shouldUseDoubleDaysForDurationTarget(
  request: ScheduleRequest,
  intentTarget: number | null,
  trainingDays: number,
): boolean {
  const target =
    intentTarget ??
    (request.dailyPreferredMinutes && request.dailyPreferredMinutes > 0
      ? request.dailyPreferredMinutes * trainingDays
      : null);
  if (!target || trainingDays <= 0) return false;
  const daily =
    request.dailyPreferredMinutes && request.dailyPreferredMinutes > 0
      ? request.dailyPreferredMinutes
      : 90;
  return target / trainingDays > Math.min(95, daily * 0.9);
}

function filterAthleteProfile(p: AthleteProfile, forceRequestedSchedule: boolean) {
  return {
    injuries: p.injuries,
    experienceLevel: p.experienceLevel,
    running: { confidence: forceRequestedSchedule ? 'high' as const : p.running.confidence },
    cycling: {
      confidence: forceRequestedSchedule ? 'high' as const : p.cycling.confidence,
      ftpWatts: p.cycling.ftpWatts ?? null,
    },
    swimming: { confidence: forceRequestedSchedule ? 'high' as const : p.swimming.confidence },
  };
}

function filterRecentState(state: RecentState, forceRequestedSchedule: boolean) {
  if (forceRequestedSchedule) {
    return {
      latestStimulus: null,
      fatigue: 'normal' as const,
    };
  }
  return {
    latestStimulus: state.latestStimulus === 'unknown' ? null : state.latestStimulus,
    fatigue: state.fatigue === 'fresh' ? 'normal' as const : state.fatigue,
  };
}

function computeHardCap(
  request: ScheduleRequest,
  athleteProfile: AthleteProfile,
  recentState: RecentState,
  trainingCapacity?: TrainingCapacity,
): number {
  const explicitHardCap =
    request.maxHardSessionsPerWeek !== null &&
    request.maxHardSessionsPerWeek !== undefined;
  const base = request.maxHardSessionsPerWeek ?? 2;
  if (request.forceRequestedSchedule === true || explicitHardCap) {
    return Math.min(7, Math.max(0, base));
  }
  const capacityCap = trainingCapacity?.guardrails.maxHardSessionsPerWeek ?? Number.POSITIVE_INFINITY;
  if (
    athleteProfile.experienceLevel === 'advanced' &&
    (recentState.fatigue === 'fresh' || recentState.fatigue === 'normal')
  ) {
    return Math.min(base, 3, capacityCap);
  }
  return Math.min(base, 2, capacityCap);
}

function effectiveTrainingDaysPerWeek(request: ScheduleRequest): number {
  return Math.min(
    7,
    Math.max(
      normalizeDaysPerWeek(request.daysPerWeek),
      requestedTrainingDayIndexes(request).size,
    ),
  );
}

function isRestLikeSport(sport: string): boolean {
  return sport === 'rest' || sport === 'mobility';
}

function areCompatibleRestLikeSports(templateSport: string, claimedSport: string): boolean {
  return isRestLikeSport(templateSport) && isRestLikeSport(claimedSport);
}

function hoursSinceLatest(state: RecentState): number | null {
  const ts = state.latestReliableActivity?.startTimeLocal?.getTime();
  if (!ts) return null;
  const ms = Date.now() - ts;
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms / (60 * 60 * 1000);
}

function addDays(yyyymmdd: string, offset: number): string {
  const [y, m, d] = yyyymmdd.split('-').map((p) => Number(p));
  if (!y || !m || !d) return yyyymmdd;
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + offset);
  const yy = base.getUTCFullYear();
  const mm = String(base.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(base.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
