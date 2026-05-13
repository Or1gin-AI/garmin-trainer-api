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
      arguments: { dayIndex: number; reason: string; slotIndex?: number; workoutId?: string };
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
    assistantContent: assistantText,
    toolCalls: accumulatedToolCalls,
    meta: {
      provider: config.name,
      model: config.model,
      inputTokens,
      outputTokens,
    },
  };
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
          '为本周第 dayIndex 天（1=周一，7=周日）重新生成训练课。同一天有多课时必须带 slotIndex 或 workoutId。reason 用中文一句说明用户的诉求或调整原因。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['dayIndex', 'reason'],
          properties: {
            dayIndex: {
              type: 'integer',
              minimum: 1,
              maximum: 7,
              description: '需要重新生成的本周天数 (1..7)',
            },
            slotIndex: {
              type: 'integer',
              minimum: 1,
              maximum: 3,
              description: '同一天多课时的课次编号；默认 1',
            },
            workoutId: {
              type: 'string',
              description: '若上下文中有 workoutId，优先用它精确指定要重生成的训练课',
            },
            reason: {
              type: 'string',
              description: '中文一句说明为什么要重新生成',
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
          '给本周第 dayIndex 天新增第二堂训练课，创建 slotIndex=2/3。用户要求“一天两练”“加第二练”“某天加练”时使用这个工具，而不是 regenerate_day。若用户让你自己决定，默认加低强度恢复/交叉训练。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['dayIndex', 'reason'],
          properties: {
            dayIndex: {
              type: 'integer',
              minimum: 1,
              maximum: 7,
              description: '需要加第二练的本周天数 (1..7)',
            },
            sport: {
              type: 'string',
              enum: ['running', 'cycling', 'swimming', 'mobility'],
              description: '用户指定或你选择的第二练项目；不填则系统自动选低冲击恢复课',
            },
            templateId: {
              type: 'string',
              description: '可选模板 id；不填时系统按安全规则选择低强度模板',
            },
            reason: {
              type: 'string',
              description: '中文一句说明为什么要新增第二练',
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
          '更新某个训练日的字段。当前仅支持把 status 改为 completed/skipped/planned。',
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
    return {
      kind: 'ok',
      call: {
        name: 'regenerate_day',
        arguments: {
          dayIndex,
          reason,
          ...(slotIndex !== undefined ? { slotIndex } : {}),
          ...(workoutId ? { workoutId } : {}),
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
  parts.push('你是一位经验丰富的耐力运动教练 AI，正在与用户讨论一份本周的训练计划。');
  parts.push('');
  parts.push('回答风格：');
  parts.push('- 全程使用中文，语气友好、专业、简洁；');
  parts.push('- 单条回答通常不超过 300 字，必要时可使用列表或加粗；');
  parts.push('- 引用某天时使用「第 X 天 / 周X」与具体的 templateId（如 run.tempo.v1），方便用户对应；');
  parts.push('- 不得编造训练负荷、配速、心率、功率等数值，所有判断必须基于下面给出的运动员档案与近期状态；');
  parts.push('- 当用户的请求模糊时，可先问 1 个澄清问题，再决定是否调用工具；');
  parts.push('- 与训练无关的问题礼貌拒绝并把话题拉回训练。');
  parts.push('');
  parts.push('修改训练计划的唯一方式是调用下列工具，禁止直接声称已修改课表：');
  parts.push('- regenerate_day(dayIndex, reason, slotIndex?, workoutId?) — 重新生成指定训练课；同一天有多课时必须传 slotIndex 或 workoutId；');
  parts.push('- add_second_workout(dayIndex, reason, sport?, templateId?) — 给某一天新增第二堂训练课；用户说“一天两练 / 加第二练 / 某天加练”时必须优先用这个工具；');
  parts.push('- update_workout_field(workoutId, field="status", value) — 修改某个训练日的状态。');
  parts.push('- 如果用户让你自己决定第二练内容，优先选择低强度恢复或低冲击交叉训练，例如跑后加恢复游；不要用 regenerate_day 代替新增课时。');
  parts.push('调用工具前请先用一句话告诉用户你打算做什么，然后再触发工具调用。');
  parts.push('');
  parts.push('# 当前计划上下文');
  parts.push(buildPlanContextBlock(input));
  return parts.join('\n');
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
