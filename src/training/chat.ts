// One-turn chat orchestrator (U10).
//
// Pure function. Caller (the route handler) wires SSE + DB persistence.
//
//   - Builds system + history + user messages, with a structured plan / 7-day
//     workouts / athlete-profile / recent-state context block.
//   - Exposes function-call tools to regenerate an existing workout, add a
//     second workout to a day, and update workout status.
//   - Streams text deltas via onTextDelta as the model speaks; when the model
//     emits tool calls, dispatches each via onToolCall and feeds the tool
//     result back as a `tool` role message, then re-enters the LLM loop.
//   - Cap loop at 3 iterations. Honors AbortSignal at each iteration boundary.
//
// Important: the LLM never modifies the DB directly. All persistence happens
// in onToolCall, which the route owns.
//
// Per-index argument accumulator pattern (matches U9's llm-scheduler /
// llm-parameterizer fix).

import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import { streamChat, getActiveLlmConfig } from '../lib/llm.js';
import type { TrainingPlan, Workout, ChatMessage } from '../db/schema.js';
import type { AthleteProfile } from './athlete-profile.js';
import type { RecentState } from './recent-state.js';
import { getCatalogForPrompt } from './templates/index.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ChatLlmNotConfiguredError extends Error {
  constructor(message = 'No active LLM config') {
    super(message);
    this.name = 'ChatLlmNotConfiguredError';
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolCall =
  | {
      name: 'regenerate_day';
      arguments: { dayIndex: number; reason: string; slotIndex?: number; workoutId?: string; templateId?: string };
    }
  | {
      name: 'add_second_workout';
      arguments: {
        dayIndex: number;
        reason: string;
        sport?: 'running' | 'cycling' | 'swimming' | 'mobility';
        templateId?: string;
      };
    }
  | {
      name: 'update_workout_field';
      arguments: {
        workoutId: string;
        field: 'status';
        value: 'completed' | 'skipped' | 'planned';
      };
    };

export interface ChatTurnInput {
  plan: TrainingPlan;
  workouts: Workout[];
  history: ChatMessage[];
  userMessage: string;
  athleteProfile: AthleteProfile;
  recentState: RecentState;
  signal?: AbortSignal;
  /** Called once per text chunk so the route can emit `event: text_delta`. */
  onTextDelta: (text: string) => void;
  /**
   * Called once when the model issues a tool call. The route persists +
   * dispatches the tool, then returns the tool-result string the model sees
   * in its next iteration.
   */
  onToolCall: (call: ToolCall) => Promise<string>;
}

export interface ChatTurnResult {
  assistantContent: string;
  toolCalls: ToolCall[];
  meta: {
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  };
}

const TOOL_REGEN = 'regenerate_day';
const TOOL_ADD_SECOND = 'add_second_workout';
const TOOL_UPDATE_FIELD = 'update_workout_field';
const MAX_ITERATIONS = 3;

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export async function runChatTurn(
  input: ChatTurnInput,
): Promise<ChatTurnResult> {
  // Probe active config first so absence is a typed error.
  let config;
  try {
    config = await getActiveLlmConfig();
  } catch (err) {
    throw new ChatLlmNotConfiguredError((err as Error).message);
  }

  const tools: ChatCompletionTool[] = buildToolDefs();

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(input) },
    ...historyToMessages(input.history),
    { role: 'user', content: input.userMessage },
  ];

  const accumulatedToolCalls: ToolCall[] = [];
  let assistantText = '';
  let inputTokens = 0;
  let outputTokens = 0;

  for (let iter = 0; iter < MAX_ITERATIONS; iter += 1) {
    if (input.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const stream = await streamChat({
      messages,
      tools,
      toolChoice: 'auto',
      temperature: 0.5,
      signal: input.signal,
    });

    // Per-index accumulator (see llm-scheduler.ts for the full rationale).
    const argsByIndex = new Map<number, string>();
    const idByIndex = new Map<number, string>();
    const nameByIndex = new Map<number, string>();
    const indexOrder: number[] = [];
    let iterationText = '';
    let finishReason: string | null = null;

    for await (const chunk of stream) {
      if (input.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (delta) {
        const textPiece = delta.content;
        if (typeof textPiece === 'string' && textPiece.length > 0) {
          iterationText += textPiece;
          input.onTextDelta(textPiece);
        }
        const toolCalls = delta.tool_calls;
        if (toolCalls && toolCalls.length > 0) {
          for (const tc of toolCalls) {
            const idx = typeof tc.index === 'number' ? tc.index : 0;
            if (!argsByIndex.has(idx)) {
              argsByIndex.set(idx, '');
              indexOrder.push(idx);
            }
            if (typeof tc.id === 'string' && tc.id.length > 0) {
              idByIndex.set(idx, tc.id);
            }
            if (typeof tc.function?.name === 'string' && tc.function.name.length > 0) {
              nameByIndex.set(idx, tc.function.name);
            }
            const piece = tc.function?.arguments;
            if (typeof piece === 'string' && piece.length > 0) {
              argsByIndex.set(idx, (argsByIndex.get(idx) ?? '') + piece);
            }
          }
        }
      }
      if (typeof choice?.finish_reason === 'string') {
        finishReason = choice.finish_reason;
      }
      const usage = chunk.usage;
      if (usage) {
        inputTokens += usage.prompt_tokens ?? 0;
        outputTokens += usage.completion_tokens ?? 0;
      }
    }

    assistantText += iterationText;

    // No tool calls issued — final answer.
    if (indexOrder.length === 0) {
      break;
    }

    // Build the assistant message that the model just emitted, including
    // tool_call entries (required so the next turn's `tool` messages can be
    // anchored to a tool_call_id).
    const toolCallEntries: ChatCompletionMessageToolCall[] = [];
    const dispatched: Array<{
      toolCallId: string;
      result: string;
    }> = [];

    for (const idx of indexOrder) {
      const callId = idByIndex.get(idx) ?? `tc_${iter}_${idx}`;
      const name = nameByIndex.get(idx) ?? '';
      const argsBuffer = argsByIndex.get(idx) ?? '';

      toolCallEntries.push({
        id: callId,
        type: 'function',
        function: { name, arguments: argsBuffer },
      });

      const parsed = parseToolCall(name, argsBuffer);
      if (parsed.kind === 'error') {
        dispatched.push({
          toolCallId: callId,
          result: JSON.stringify({ error: parsed.message }),
        });
        continue;
      }
      accumulatedToolCalls.push(parsed.call);
      let result: string;
      try {
        result = await input.onToolCall(parsed.call);
      } catch (err) {
        result = JSON.stringify({
          error: `tool_dispatch_failed: ${(err as Error).message}`,
        });
      }
      dispatched.push({ toolCallId: callId, result });
    }

    messages.push({
      role: 'assistant',
      content: iterationText.length > 0 ? iterationText : null,
      tool_calls: toolCallEntries,
    });
    for (const d of dispatched) {
      messages.push({
        role: 'tool',
        tool_call_id: d.toolCallId,
        content: d.result,
      });
    }

    // If model says it's done despite emitting tool_calls (unusual), break;
    // otherwise loop so the model can react to tool results.
    if (finishReason && finishReason !== 'tool_calls') {
      // 'stop' or other terminal reason — done.
      break;
    }
  }

  return {
    assistantContent: assistantText.trim().length > 0
      ? assistantText
      : buildFallbackCoachReply(input, accumulatedToolCalls.length > 0),
    toolCalls: accumulatedToolCalls,
    meta: {
      provider: config.name,
      model: config.model,
      inputTokens,
      outputTokens,
    },
  };
}

function buildFallbackCoachReply(input: ChatTurnInput, usedTools: boolean): string {
  const text = input.userMessage.trim();
  const asksLoad =
    /(负荷|\bload\b)/i.test(text) &&
    /(为什么|为何|怎么|不一样|不同|差异|差这么多|差距|\bwhy\b|\bhow\b|differ|different|difference|\bgap\b)/i.test(text);

  if (asksLoad) {
    const loadRows = input.workouts
      .map((w) => {
        const vars = w.parameterSource?.replacedVariables as
          | Record<string, string | number>
          | undefined;
        const load = Number(vars?.__estimated_training_load);
        return Number.isFinite(load) && load > 0
          ? `Day ${w.dayIndex} ${w.title}: ${Math.round(load)}`
          : null;
      })
      .filter((row): row is string => Boolean(row));
    const loadText = loadRows.length > 0
      ? `\n\nEstimated loads visible in the current plan: ${loadRows.join('; ')}.`
      : '';
    return [
      'Training load is not based on the title or card duration alone. It is estimated from the session\'s total duration, workout type, the time spent at each intensity in the structure, and your heart-rate/pace profile.',
      'So even when both sessions are Zone 2, a long run (LSD) with a longer main set scores higher than a regular aerobic run, while threshold, VO2 and interval sessions score noticeably higher because a larger share of their minutes is high intensity.',
      'If two sessions have almost identical structure and duration but different loads, that is a plan-generation consistency issue and the plan itself should be fixed, rather than explained away as a reasonable difference.',
    ].join('\n\n') + loadText;
  }

  return usedTools
    ? 'I finished looking up the data I needed, but the model returned no text this turn. Please send your question again and I will answer based on the profile and plan I just loaded.'
    : 'The model returned no usable text this turn. Please send your question again and I will keep answering based on your current training plan.';
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

function buildToolDefs(): ChatCompletionTool[] {
  return [
    {
      type: 'function',
      function: {
        name: TOOL_REGEN,
        description:
          'Regenerate or replace the session on day dayIndex of this week (1=Monday, 7=Sunday). When the day has several sessions you must pass slotIndex or workoutId. When the user explicitly asks to "replace with / change to" a specific workout you must pass templateId. reason is one English sentence describing the user\'s request or why the change is made.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['dayIndex', 'reason'],
          properties: {
            dayIndex: {
              type: 'integer',
              minimum: 1,
              maximum: 7,
              description: 'Day of this week to regenerate (1..7)',
            },
            slotIndex: {
              type: 'integer',
              minimum: 1,
              maximum: 3,
              description: 'Session number when the day has several sessions; defaults to 1',
            },
            workoutId: {
              type: 'string',
              description: 'If the context has a workoutId, prefer it to identify exactly which session to regenerate',
            },
            templateId: {
              type: 'string',
              description: 'Optional template id; required when the user explicitly asks to change the workout type, e.g. run.reverse_pyramid.v1, run.threshold.v1',
            },
            reason: {
              type: 'string',
              description: 'One English sentence explaining why the session is regenerated',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: TOOL_ADD_SECOND,
        description:
          'Add a second session on day dayIndex of this week, creating slotIndex=2/3. Use this tool (not regenerate_day) when the user asks for "two sessions in one day", "add a second session" or "add an extra session on some day". When the user explicitly names a workout type you must pass templateId; only default to a low-intensity recovery/cross-training session when the user leaves the choice to you.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['dayIndex', 'reason'],
          properties: {
            dayIndex: {
              type: 'integer',
              minimum: 1,
              maximum: 7,
              description: 'Day of this week that gets the second session (1..7)',
            },
            sport: {
              type: 'string',
              enum: ['running', 'cycling', 'swimming', 'mobility'],
              description: 'Sport for the second session, specified by the user or chosen by you; if omitted the system picks a low-impact recovery session',
            },
            templateId: {
              type: 'string',
              description: 'Optional template id; use run.double_threshold_pm.v1 for an explicit double threshold and run.reverse_pyramid.v1 for a reverse pyramid run; if omitted the system picks a low-intensity template using safety rules',
            },
            reason: {
              type: 'string',
              description: 'One English sentence explaining why the second session is added',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: TOOL_UPDATE_FIELD,
        description:
          'Update a field of a training session. Currently only supports setting status to completed/skipped/planned.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['workoutId', 'field', 'value'],
          properties: {
            workoutId: { type: 'string' },
            field: { type: 'string', enum: ['status'] },
            value: {
              type: 'string',
              enum: ['completed', 'skipped', 'planned'],
            },
          },
        },
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Tool-call parsing
// ---------------------------------------------------------------------------

type ParseResult =
  | { kind: 'ok'; call: ToolCall }
  | { kind: 'error'; message: string };

function parseToolCall(name: string, argsBuffer: string): ParseResult {
  if (argsBuffer.length === 0) {
    return { kind: 'error', message: `${name}: empty arguments` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsBuffer);
  } catch (err) {
    return {
      kind: 'error',
      message: `${name}: JSON.parse failed (${(err as Error).message})`,
    };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { kind: 'error', message: `${name}: arguments must be an object` };
  }
  const obj = parsed as Record<string, unknown>;

  if (name === TOOL_REGEN) {
    const dayIndex = obj.dayIndex;
    const reason = obj.reason;
    const slotIndex = obj.slotIndex;
    const workoutId = obj.workoutId;
    const templateId = obj.templateId;
    if (
      typeof dayIndex !== 'number' ||
      !Number.isInteger(dayIndex) ||
      dayIndex < 1 ||
      dayIndex > 7
    ) {
      return {
        kind: 'error',
        message: `${name}: dayIndex must be integer 1..7`,
      };
    }
    if (typeof reason !== 'string' || reason.length === 0) {
      return { kind: 'error', message: `${name}: reason must be a non-empty string` };
    }
    if (
      slotIndex !== undefined &&
      (typeof slotIndex !== 'number' ||
        !Number.isInteger(slotIndex) ||
        slotIndex < 1 ||
        slotIndex > 3)
    ) {
      return { kind: 'error', message: `${name}: slotIndex must be integer 1..3` };
    }
    if (workoutId !== undefined && typeof workoutId !== 'string') {
      return { kind: 'error', message: `${name}: workoutId must be a string` };
    }
    if (templateId !== undefined && typeof templateId !== 'string') {
      return { kind: 'error', message: `${name}: templateId must be a string` };
    }
    return {
      kind: 'ok',
      call: {
        name: 'regenerate_day',
        arguments: {
          dayIndex,
          reason,
          ...(slotIndex !== undefined ? { slotIndex } : {}),
          ...(workoutId ? { workoutId } : {}),
          ...(templateId ? { templateId } : {}),
        },
      },
    };
  }

  if (name === TOOL_ADD_SECOND) {
    const dayIndex = obj.dayIndex;
    const reason = obj.reason;
    const sport = obj.sport;
    const templateId = obj.templateId;
    if (
      typeof dayIndex !== 'number' ||
      !Number.isInteger(dayIndex) ||
      dayIndex < 1 ||
      dayIndex > 7
    ) {
      return {
        kind: 'error',
        message: `${name}: dayIndex must be integer 1..7`,
      };
    }
    if (typeof reason !== 'string' || reason.length === 0) {
      return { kind: 'error', message: `${name}: reason must be a non-empty string` };
    }
    if (
      sport !== undefined &&
      sport !== 'running' &&
      sport !== 'cycling' &&
      sport !== 'swimming' &&
      sport !== 'mobility'
    ) {
      return { kind: 'error', message: `${name}: sport must be running|cycling|swimming|mobility` };
    }
    if (templateId !== undefined && typeof templateId !== 'string') {
      return { kind: 'error', message: `${name}: templateId must be a string` };
    }
    return {
      kind: 'ok',
      call: {
        name: 'add_second_workout',
        arguments: {
          dayIndex,
          reason,
          ...(sport ? { sport } : {}),
          ...(templateId ? { templateId } : {}),
        },
      },
    };
  }

  if (name === TOOL_UPDATE_FIELD) {
    const workoutId = obj.workoutId;
    const field = obj.field;
    const value = obj.value;
    if (typeof workoutId !== 'string' || workoutId.length === 0) {
      return { kind: 'error', message: `${name}: workoutId required` };
    }
    if (field !== 'status') {
      return { kind: 'error', message: `${name}: only field='status' supported` };
    }
    if (value !== 'completed' && value !== 'skipped' && value !== 'planned') {
      return {
        kind: 'error',
        message: `${name}: value must be completed|skipped|planned`,
      };
    }
    return {
      kind: 'ok',
      call: {
        name: 'update_workout_field',
        arguments: { workoutId, field: 'status', value },
      },
    };
  }

  return { kind: 'error', message: `unknown tool: ${name}` };
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function buildSystemPrompt(input: ChatTurnInput): string {
  const parts: string[] = [];
  parts.push('You are an experienced endurance coaching AI discussing this week\'s training plan with the user.');
  parts.push('');
  parts.push('Response style:');
  parts.push('- Always reply in English, even if the user writes in another language (e.g. Chinese); keep a friendly, professional and concise tone;');
  parts.push('- Keep a single reply to roughly 200 words or fewer; lists or bold text are fine when useful;');
  parts.push('- When referring to a day, use "Day X / weekday" together with the specific templateId (e.g. run.tempo.v1) so the user can match it;');
  parts.push('- Never invent training load, pace, heart rate, power or other numbers; every judgement must be based on the athlete profile and recent state given below;');
  parts.push('- When the request is ambiguous you may ask 1 clarifying question before deciding whether to call a tool;');
  parts.push('- Politely decline questions unrelated to training and steer the conversation back to training.');
  parts.push('');
  parts.push('Important behaviour rules:');
  parts.push('- When the user explicitly says "replace / change to / add / second session" and names a workout type, do not ask how exactly to do it; pick the closest template from the library and call the tool.');
  parts.push('- Only ask a clarifying question when the day, the action (add vs. replace) or the target workout is completely unclear.');
  parts.push('- If the user asks for high-intensity or advanced work, you may warn about recovery risk in one sentence, but you must respect the explicit request and call the tool; never silently turn an explicit double threshold, reverse pyramid, intervals, etc. into a recovery swim/recovery run.');
  parts.push('- Common phrase mapping (users may write these in English or Chinese): double threshold / 双阈值 → run.double_threshold_pm.v1 (add as second session) or run.double_threshold_am.v1 (replace the main session); reverse pyramid / 倒金字塔 / 递减金字塔 → run.reverse_pyramid.v1; threshold run / Zone 4 / Z4 / 阈值跑 → run.threshold.v1; tempo run / 节奏跑 → run.tempo.v1; intervals / 800s / 400s / 间歇 → run.interval.v1; VO2 / VO2max / 最大摄氧 → run.vo2max.v1.');
  parts.push('');
  parts.push('The only way to change the training plan is to call the tools below; never claim the plan has been changed without calling them:');
  parts.push('- regenerate_day(dayIndex, reason, slotIndex?, workoutId?, templateId?) — regenerate or replace a specific session; when the day has several sessions you must pass slotIndex or workoutId; pass templateId when the user says "replace / change to";');
  parts.push('- add_second_workout(dayIndex, reason, sport?, templateId?) — add a second session on a day; you must prefer this tool when the user says "two sessions in one day / add a second session / add an extra session on some day";');
  parts.push('- update_workout_field(workoutId, field="status", value) — change the status of a session.');
  parts.push('- If the user lets you decide the second session, prefer low-intensity recovery or low-impact cross-training, e.g. a recovery swim after a run; do not use regenerate_day in place of adding a session.');
  parts.push('Tool arguments such as reason must also be written in English. Before calling a tool, tell the user in one sentence what you are about to do, then make the tool call.');
  parts.push('');
  parts.push('# Available workout templates');
  parts.push(getCatalogForPrompt());
  parts.push('');
  parts.push('# Intent hints for this turn');
  parts.push(buildIntentHint(input.userMessage));
  parts.push('');
  parts.push('# Current plan context');
  parts.push(buildPlanContextBlock(input));
  return parts.join('\n');
}

function buildIntentHint(userMessage: string): string {
  const dayIndex = inferDayIndex(userMessage);
  const templateId = inferTemplateIdFromText(userMessage);
  const isAdd = /(加|新增|添加|第二练|第二堂|一天两练|双练|double\s*day|\badd\b|second\s*(session|workout)|extra\s*(session|workout)|two-a-day)/i.test(userMessage);
  const isReplace = /(替换|换成|改成|改为|换掉|replace|\bswap\b|change\s*(it\s*)?to|switch\s*(it\s*)?to|instead\s*of)/i.test(userMessage);
  return JSON.stringify(
    {
      dayIndex,
      action: isAdd ? 'add_second_workout' : isReplace ? 'regenerate_day_with_templateId' : null,
      inferredTemplateId: templateId,
      note: templateId
        ? 'The user named a recognizable workout type; if the day and action are clear enough, call the tool directly instead of asking about the workout structure.'
        : 'If the user named a workout type that was not recognized here, pick the closest templateId from the template library.',
    },
    null,
    2,
  );
}

function inferDayIndex(text: string): number | null {
  const patterns: Array<[number, RegExp]> = [
    [1, /(周一|星期一|礼拜一|第\s*1\s*天|\bday\s*1\b|\bmonday\b|\bmon\b)/i],
    [2, /(周二|星期二|礼拜二|第\s*2\s*天|\bday\s*2\b|\btuesday\b|\btue\b)/i],
    [3, /(周三|星期三|礼拜三|第\s*3\s*天|\bday\s*3\b|\bwednesday\b|\bwed\b)/i],
    [4, /(周四|星期四|礼拜四|第\s*4\s*天|\bday\s*4\b|\bthursday\b|\bthu\b)/i],
    [5, /(周五|星期五|礼拜五|第\s*5\s*天|\bday\s*5\b|\bfriday\b|\bfri\b)/i],
    [6, /(周六|星期六|礼拜六|第\s*6\s*天|\bday\s*6\b|\bsaturday\b|\bsat\b)/i],
    [7, /(周日|周天|星期日|星期天|礼拜日|礼拜天|第\s*7\s*天|\bday\s*7\b|\bsunday\b|\bsun\b)/i],
  ];
  return patterns.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

function inferTemplateIdFromText(text: string): string | null {
  const lower = text.toLowerCase();
  if (/双阈值|double\s*threshold/.test(lower)) return 'run.double_threshold_pm.v1';
  if (/倒金字塔|递减金字塔|reverse\s*pyramid|inverted\s*pyramid/.test(lower)) {
    return 'run.reverse_pyramid.v1';
  }
  if (/最大摄氧|vo2|max\s*oxygen|vvo2/.test(lower)) return 'run.vo2max.v1';
  if (/短间歇|间歇|400|800|interval/.test(lower)) return 'run.interval.v1';
  if (/threshold\s*(ride|bike)|(bike|ride|cycling).*threshold/.test(lower)) return 'bike.threshold.v1';
  if (/threshold\s*swim|swim.*threshold|\bcss\b/.test(lower)) return 'swim.css_threshold.v1';
  if (/recovery\s*swim|swim.*recovery/.test(lower)) return 'swim.recovery.v1';
  if (/recovery\s*(ride|spin|bike)|(ride|bike).*recovery/.test(lower)) return 'bike.recovery_spin.v1';
  if (/阈值跑|跑.*阈值|threshold|zone\s*4|z4|hr\s*z4/.test(lower)) return 'run.threshold.v1';
  if (/节奏跑|tempo/.test(lower)) return 'run.tempo.v1';
  if (/递进跑|progression/.test(lower)) return 'run.progression.v1';
  if (/大步跑|strides?/.test(lower)) return 'run.strides.v1';
  if (/坡跑|上坡|hill/.test(lower)) return 'run.hill.v1';
  if (/恢复游|恢复.*游/.test(lower)) return 'swim.recovery.v1';
  if (/恢复骑|恢复.*骑/.test(lower)) return 'bike.recovery_spin.v1';
  if (/阈值骑|骑.*阈值/.test(lower)) return 'bike.threshold.v1';
  if (/甜区|sweet\s*spot/.test(lower)) return 'bike.sweet_spot.v1';
  if (/恢复跑|恢复.*跑|recovery\s*run|easy\s*recovery/.test(lower)) return 'run.recovery.v1';
  return null;
}

function buildPlanContextBlock(input: ChatTurnInput): string {
  const planSummary = {
    id: input.plan.id,
    weekStartDate: String(input.plan.weekStartDate),
    status: input.plan.status,
    summary: input.plan.summary ?? null,
    monitoring: input.plan.monitoring ?? null,
    adjustmentRules: input.plan.adjustmentRules ?? null,
  };

  const sortedWorkouts = input.workouts
    .slice()
    .sort((a, b) => a.dayIndex - b.dayIndex || (a.slotIndex ?? 1) - (b.slotIndex ?? 1))
    .map((w) => ({
      workoutId: w.id,
      dayIndex: w.dayIndex,
      slotIndex: w.slotIndex ?? 1,
      sessionLabel: w.sessionLabel ?? null,
      timeOfDay: w.timeOfDay ?? null,
      date: String(w.date),
      sport: w.sport,
      templateId: w.templateId,
      title: w.title,
      intensity: w.intensity,
      durationMinutes: w.durationMinutes,
      distanceKm: w.distanceKm !== null ? Number(w.distanceKm) : null,
      targetMetric: w.targetMetric,
      targetHeartRate: w.targetHeartRate,
      targetPace: w.targetPace,
      targetPower: w.targetPower,
      workoutStructure: w.workoutStructure,
      targets: w.targets ?? [],
      adaptation: w.adaptation,
      status: w.status,
    }));

  const profile = {
    experienceLevel: input.athleteProfile.experienceLevel,
    heartRate: input.athleteProfile.heartRate,
    running: input.athleteProfile.running,
    cycling: input.athleteProfile.cycling,
    swimming: input.athleteProfile.swimming,
    injuries: input.athleteProfile.injuries,
  };

  const recent = {
    latestStimulus: input.recentState.latestStimulus,
    fatigue: input.recentState.fatigue,
    hardSessionsLast7d: input.recentState.hardSessionsLast7d,
    load7d: input.recentState.load7d,
    load28d: input.recentState.load28d,
    loadTrend: input.recentState.loadTrend,
    recommendation: input.recentState.recommendation,
  };

  return JSON.stringify(
    {
      plan: planSummary,
      workouts: sortedWorkouts,
      athleteProfile: profile,
      recentState: recent,
    },
    null,
    2,
  );
}

function historyToMessages(
  history: ChatMessage[],
): ChatCompletionMessageParam[] {
  // Replay only user/assistant turns; tool messages from prior turns are
  // dropped because their tool_call_ids are scoped to those turns and would
  // be rejected by some providers if reused without the originating call.
  const out: ChatCompletionMessageParam[] = [];
  const sorted = history
    .slice()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const msg of sorted) {
    if (msg.role === 'user') {
      out.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      // Strip prior tool-call shells; the assistant content alone is enough
      // for context, and the linked tool_calls for THAT prior turn are not
      // re-played.
      out.push({ role: 'assistant', content: msg.content });
    }
    // role === 'tool' messages are skipped on replay.
  }
  return out;
}
