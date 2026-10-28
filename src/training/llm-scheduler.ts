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
  'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun',
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
          'Pick a templateId from the allowed template list for each day of this week\'s schedule, with a one-line English reason. One entry per dayIndex by default; when the user explicitly asks for two sessions in one day, return two entries for that dayIndex with slotIndex=1/2.',
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
                    description: 'Session number when a day has several sessions; omit or use 1 for a single session',
                  },
                  sessionLabel: {
                    type: 'string',
                    description: 'In English, e.g. "AM" / "PM"; omit for a single session',
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
                  reason: { type: 'string', description: 'One-line explanation in English' },
                },
              },
            },
            notes: {
              type: 'array',
              items: { type: 'string' },
              description: 'Risk notes and remarks, each written in English',
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
    'You are a professional endurance coach planning a 7-day training week for the user. Every session must use a templateId from the allowed template list below; never invent template ids or parameters.',
  );
  systemParts.push(
    'Language: write every natural-language field (reason, sessionLabel, notes) in English, even if the user\'s goal or notes are written in another language.',
  );
  systemParts.push(
    'Top priority: workout types, number of training days, same-day double sessions and weekly time targets that the user explicitly wrote take precedence over the protective health rules; if there is a risk, only mention it in notes — do not remove or replace sessions the user explicitly asked for.',
  );
  systemParts.push('Explicit user intent:');
  systemParts.push(formatTrainingIntentForPrompt(args.requestIntent));
  systemParts.push(
    'Hard rules:',
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
      '- You must cover all 7 dayIndex values (1..7). The days array may have more than 7 entries to satisfy same-day double sessions or the average session-length target; use slotIndex=1/2 on the same dayIndex for the AM/PM sessions. Extra sessions should preferably use low-intensity Z2, aerobic, recovery or technique templates.',
    );
    systemParts.push(
      '- When the user has several sports enabled, unless they explicitly asked for "double threshold" / two sessions of the same sport, the second session of a day should preferably be a low-stress recovery or technique session in a different sport; do not stack plain aerobic sessions of the same sport or the same templateId.',
    );
  } else {
    systemParts.push('- Output exactly 7 entries covering dayIndex 1..7;');
  }
  systemParts.push(
    `- The user chose ${requestedTrainingDays} training days per week: exactly ${requestedTrainingDays} days must use running/cycling/swimming templates, and only the remaining ${requestedRestDays} days may use rest/mobility templates;`,
  );
  if (protectedTrainingDays.size > 0) {
    systemParts.push(
      `- The user explicitly named ${formatDayIndexes(protectedTrainingDays)} as training days: these dayIndex values must not use rest/mobility templates and must not be turned into rest by the default rest day, recent fatigue or capacity protection.`,
    );
  }
  if (requestedTrainingDays === 7) {
    systemParts.push(
      '- The user chose 7 training days per week: rest and mobility templates are forbidden; all 7 days must be actual sport sessions, and recovery may only use each sport\'s low-intensity recovery templates.',
    );
  }
  systemParts.push('- Every non-rest day must use a templateId from the allowed list;');
  if (args.request.forceRequestedSchedule !== true) {
    systemParts.push('- No two consecutive days may both contain an intensity=high session;');
  } else {
    systemParts.push(
      '- Strict mode is on: do not automatically reduce the training days/intensity the user asked for because of back-to-back hard days, recent training stimulus or the capacity assessment; mention these only as risk notes in notes.',
    );
  }
  systemParts.push(
    `- Coaching recommendation: no more than ${computeHardCap(
      args.request,
      args.athleteProfile,
      args.recentState,
      args.trainingCapacity,
    )} high-intensity sessions this week; if the user explicitly asks for more, only warn about the risk — do not remove the user's request.`,
  );
  if (
    args.request.maxHardSessionsPerWeek !== null &&
    args.request.maxHardSessionsPerWeek !== undefined
  ) {
    const hardLine = args.request.forceRequestedSchedule === true
      ? `- The user chose ${args.request.maxHardSessionsPerWeek} high-intensity sessions per week; in strict mode this is the target count. When there are enough training days and advanced workouts are allowed, schedule exactly this many. Do not exceed it unless the user's text explicitly names more specific hard sessions.`
      : `- The user's weekly high-intensity cap is ${args.request.maxHardSessionsPerWeek} sessions; this is a user requirement. Do not exceed it unless the user's text explicitly names more specific hard sessions.`;
    systemParts.push(hardLine);
  }
  if (args.request.forceRequestedSchedule !== true) {
    systemParts.push(
      '- If there was a threshold/vo2max/anaerobic session in the last 36 hours, day 1 must not contain a high-intensity session;',
    );
  }
  systemParts.push(
    `- Total training time this week must not exceed ${args.request.weeklyMaxMinutes ?? MAX_WEEKLY_TRAINING_MINUTES} min;`,
  );
  if (args.requestIntent.weeklyTargetMinutes !== null) {
    systemParts.push(
      `- The user stated a weekly training target of about ${args.requestIntent.weeklyTargetMinutes} min: get as close to it as possible without exceeding the weekly cap; add time mainly through Z2, long, recovery and technique sessions, and for quality sessions only extend the warm-up/cool-down or recovery segments.`,
    );
  }
  systemParts.push(
    '- The sport field must match the sport of the chosen templateId\'s template;',
  );
  if (requestedTrainingDays < 7) {
    systemParts.push(
      '- Use rest templates for rest days (rest.full.v1 / rest.mobility.v1).',
    );
  }
  systemParts.push(
    '- If one sport has several high-intensity sessions in a week, they should cover different training purposes, e.g. threshold / interval / VO2max / race_pace; do not repeat the same high-intensity template without a reason;',
  );
  systemParts.push(
    '- For runners with 2 quality sessions in a week, usually one leans threshold/tempo and the other intervals/VO2max, unless recent fatigue or template contraindications rule it out;',
  );
  systemParts.push(
    '- If the user enabled swimming, cycling and running and has enough training days, the week must cover all three sports; do not build the week around running only.',
  );
  systemParts.push(
    '- For cycling with a known FTP prefer power targets; for swimming prefer CSS / per-100m pace; for low-intensity running prefer heart-rate zones.',
  );
  if (args.request.dailyPreferredMinutes && args.request.dailyPreferredMinutes > 0) {
    systemParts.push(
      `- The user's ${args.request.dailyPreferredMinutes} min is a reference for the average training-day duration, not a hard cap per session; the week as a whole should bring the average training-day duration close to it. Low-intensity Z2/aerobic/long sessions may exceed it, and Z2 rides for advanced athletes should usually be no shorter than 75-90 min. Do not stretch threshold/VO2/interval main sets just to fill time.`,
    );
    systemParts.push(
      '- If that duration is below the minimum workable duration of a long-session template, do not label a regular aerobic session as long/LSD: run.lsd.v1 needs at least 70 min and bike.long_ride.v1 at least 90 min; use aerobic/endurance/recovery templates for shorter sessions.',
    );
    if (args.request.dailyPreferredMinutes < 30) {
      systemParts.push(
        '- The user\'s daily time is very short: prefer recovery/technique templates; do not squeeze regular aerobic, long or complex quality sessions into the short window.',
      );
    }
  }
  if (args.isColdStart) {
    systemParts.push(
      '- This user has very little structured training history or no usable fitness profile yet; this week must be conservative, favouring low intensity, aerobic base, technique and recovery, and avoiding aggressive pace/power-driven high-risk structures.',
    );
  }
  if (args.trainingCapacity) {
    systemParts.push(
      `- Training-capacity assessment: level=${args.trainingCapacity.overall.level}, readiness=${args.trainingCapacity.overall.readiness}, confidence=${args.trainingCapacity.overall.readinessConfidence}; high-intensity cap ${args.trainingCapacity.guardrails.maxHardSessionsPerWeek} sessions; high-intensity minutes share cap ${Math.round(args.trainingCapacity.guardrails.maxHighMinutesShare * 100)}%.`,
    );
    systemParts.push(
      '- Weekly coaching rule: low-intensity training should make up the bulk of the week; do not fill the user\'s available time with several long threshold/VO2/interval sessions; a long run/long ride is only part of that sport\'s weekly volume and must not swallow most of the training minutes.',
    );
    if (args.request.forceRequestedSchedule === true) {
      systemParts.push(
        '- The user explicitly asked to generate the plan as requested: do not automatically remove the requested training frequency/high-intensity intent because of capacity protection, but you must explain the risks and why it is not recommended in notes.',
      );
    } else if (!args.trainingCapacity.guardrails.allowHighIntensity) {
      systemParts.push(
        '- Capacity/recovery protection: no intensity=high templates this week; only low-intensity, technique or recovery sessions are allowed.',
      );
    }
  }
  if (args.request.preferredTrainingWindows && args.request.preferredTrainingWindows.length > 0) {
    systemParts.push(
      `- User's preferred training windows: ${args.request.preferredTrainingWindows.join(', ')}; the schedule will label timeOfDay from these windows.`,
    );
  }
  if (args.request.allowAdvancedWorkouts !== true) {
    if (args.request.forceRequestedSchedule === true && args.requestIntent.requiredWorkouts.length > 0) {
      systemParts.push(
        '- The user has not turned on advanced workouts, but explicitly asked for advanced sessions in their text; follow the text this time, schedule the matching templates and warn about the risks in notes.',
      );
    } else {
      systemParts.push(
        '- The user has not turned on advanced workouts: do not schedule VO2max, short intervals, anaerobic, sprints, hill runs/climbing, race-specific, open-water-specific, double-threshold or same-day double sessions.',
      );
    }
  } else {
    systemParts.push(
      '- The user has turned on advanced workouts: any advanced template the user names must be scheduled; advanced templates the user did not name should still be chosen carefully based on training background, fatigue, contraindications and the high-intensity cap.',
    );
  }
  systemParts.push('');
  systemParts.push('Allowed template list (one per line: id | sport | intensity | purpose | block:contraindications):');
  systemParts.push(args.catalog || '(empty)');

  if (args.retryViolations && args.retryViolations.length > 0) {
    systemParts.push('');
    systemParts.push('Your previous output broke the rules. Re-plan the week and avoid the following problems:');
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
      content: `Plan this week's training for the following user and return it via the ${TOOL_NAME} tool (all text in English).\n\n${JSON.stringify(user, null, 2)}`,
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
  return /双阈值|双阈|同项目.*两练|两练.*同项目|一天.*两.*跑|一天.*两.*骑|一天.*两.*游|double\s*threshold|same[-\s]?sport|two\s*(runs|rides|swims)\s*(in\s*)?(one|a|the\s*same)\s*day/i.test(text);
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
