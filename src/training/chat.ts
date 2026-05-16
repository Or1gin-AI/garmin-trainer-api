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
    /负荷/.test(text) &&
    /(为什么|为何|怎么|不一样|不同|差异|差这么多|差距)/.test(text);

  if (asksLoad) {
    const loadRows = input.workouts
      .map((w) => {
        const vars = w.parameterSource?.replacedVariables as
          | Record<string, string | number>
          | undefined;
        const load = Number(vars?.__estimated_training_load);
        return Number.isFinite(load) && load > 0
          ? `第 ${w.dayIndex} 天 ${w.title}：${Math.round(load)}`
          : null;
      })
      .filter((row): row is string => Boolean(row));
    const loadText = loadRows.length > 0
      ? `\n\n当前计划中可见的预估负荷是：${loadRows.join('；')}。`
      : '';
    return [
      '训练负荷不只看标题或卡片时长，而是按这节课的总时长、训练类型、结构里的强度时间，以及你的心率/配速画像一起估计。',
      '所以同样是 Zone 2，LSD 如果主训练更长，会比普通有氧跑更高；阈值、VO2、间歇则会因为高强度分钟占比更高而显著增加。',
      '如果你看到两节课结构和时长几乎一样但负荷不同，那就是计划生成一致性问题，应该修计划本身，而不是解释成合理差异。',
    ].join('\n\n') + loadText;
  }

  return usedTools
    ? '我已经完成了必要的数据查询，但模型这轮没有返回文字。请再发一次你的问题，我会基于刚加载的画像和计划继续回答。'
    : '这轮模型没有返回有效文字。请再发一次你的问题，我会继续基于当前训练计划回答。';
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
          '为本周第 dayIndex 天（1=周一，7=周日）重新生成或替换训练课。同一天有多课时必须带 slotIndex 或 workoutId。用户明确要求“替换成/改成某训练”时必须传 templateId。reason 用中文一句说明用户的诉求或调整原因。',
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
            templateId: {
              type: 'string',
              description: '可选模板 id；用户明确要求替换训练类型时必须填写，例如 run.reverse_pyramid.v1、run.threshold.v1',
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
          '给本周第 dayIndex 天新增第二堂训练课，创建 slotIndex=2/3。用户要求“一天两练”“加第二练”“某天加练”时使用这个工具，而不是 regenerate_day。用户明确要求训练类型时必须传 templateId；只有用户让你自己决定时，才默认加低强度恢复/交叉训练。',
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
              description: '可选模板 id；明确双阈值用 run.double_threshold_pm.v1，倒金字塔跑用 run.reverse_pyramid.v1；不填时系统按安全规则选择低强度模板',
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
  parts.push('重要行为规则：');
  parts.push('- 用户明确说「替换/改成/加/新增/第二练」并给出训练类型时，不要反问具体怎么练；你应根据模板库自动选择最接近模板并调用工具。');
  parts.push('- 只有缺少日期、动作（新增还是替换）或目标训练完全无法识别时，才问澄清问题。');
  parts.push('- 如果用户要求高强度或高级训练，可以先用一句话提示恢复风险，但必须尊重明确请求并调用工具；不要把明确的双阈值、倒金字塔、间歇等自动改成恢复游/恢复跑。');
  parts.push('- 常见口语映射：双阈值/Double Threshold → run.double_threshold_pm.v1（新增第二练）或 run.double_threshold_am.v1（替换主课）；倒金字塔/递减金字塔/reverse pyramid → run.reverse_pyramid.v1；阈值跑/Zone4/Z4 → run.threshold.v1；节奏跑/tempo → run.tempo.v1；间歇/800/400 → run.interval.v1；VO2/最大摄氧 → run.vo2max.v1。');
  parts.push('');
  parts.push('修改训练计划的唯一方式是调用下列工具，禁止直接声称已修改课表：');
  parts.push('- regenerate_day(dayIndex, reason, slotIndex?, workoutId?, templateId?) — 重新生成或替换指定训练课；同一天有多课时必须传 slotIndex 或 workoutId；用户说「替换/改成」时传 templateId；');
  parts.push('- add_second_workout(dayIndex, reason, sport?, templateId?) — 给某一天新增第二堂训练课；用户说“一天两练 / 加第二练 / 某天加练”时必须优先用这个工具；');
  parts.push('- update_workout_field(workoutId, field="status", value) — 修改某个训练日的状态。');
  parts.push('- 如果用户让你自己决定第二练内容，优先选择低强度恢复或低冲击交叉训练，例如跑后加恢复游；不要用 regenerate_day 代替新增课时。');
  parts.push('调用工具前请先用一句话告诉用户你打算做什么，然后再触发工具调用。');
  parts.push('');
  parts.push('# 可用训练模板');
  parts.push(getCatalogForPrompt());
  parts.push('');
  parts.push('# 本轮用户意图提示');
  parts.push(buildIntentHint(input.userMessage));
  parts.push('');
  parts.push('# 当前计划上下文');
  parts.push(buildPlanContextBlock(input));
  return parts.join('\n');
}

function buildIntentHint(userMessage: string): string {
  const dayIndex = inferDayIndex(userMessage);
  const templateId = inferTemplateIdFromText(userMessage);
  const isAdd = /(加|新增|添加|第二练|第二堂|一天两练|双练|double\s*day)/i.test(userMessage);
  const isReplace = /(替换|换成|改成|改为|换掉|replace)/i.test(userMessage);
  return JSON.stringify(
    {
      dayIndex,
      action: isAdd ? 'add_second_workout' : isReplace ? 'regenerate_day_with_templateId' : null,
      inferredTemplateId: templateId,
      note: templateId
        ? '用户已给出可识别训练类型；如果日期和动作足够明确，应直接调用工具，不要追问训练结构。'
        : '若用户给出的是训练类型但这里未识别，请从模板库选择最接近的 templateId。',
    },
    null,
    2,
  );
}

function inferDayIndex(text: string): number | null {
  const patterns: Array<[number, RegExp]> = [
    [1, /(周一|星期一|礼拜一|第\s*1\s*天|day\s*1|monday|mon)/i],
    [2, /(周二|星期二|礼拜二|第\s*2\s*天|day\s*2|tuesday|tue)/i],
    [3, /(周三|星期三|礼拜三|第\s*3\s*天|day\s*3|wednesday|wed)/i],
    [4, /(周四|星期四|礼拜四|第\s*4\s*天|day\s*4|thursday|thu)/i],
    [5, /(周五|星期五|礼拜五|第\s*5\s*天|day\s*5|friday|fri)/i],
    [6, /(周六|星期六|礼拜六|第\s*6\s*天|day\s*6|saturday|sat)/i],
    [7, /(周日|周天|星期日|星期天|礼拜日|礼拜天|第\s*7\s*天|day\s*7|sunday|sun)/i],
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
  if (/阈值跑|跑.*阈值|threshold|zone\s*4|z4|hr\s*z4/.test(lower)) return 'run.threshold.v1';
  if (/节奏跑|tempo/.test(lower)) return 'run.tempo.v1';
  if (/递进跑|progression/.test(lower)) return 'run.progression.v1';
  if (/大步跑|strides?/.test(lower)) return 'run.strides.v1';
  if (/坡跑|上坡|hill/.test(lower)) return 'run.hill.v1';
  if (/恢复游|恢复.*游/.test(lower)) return 'swim.recovery.v1';
  if (/恢复骑|恢复.*骑/.test(lower)) return 'bike.recovery_spin.v1';
  if (/阈值骑|骑.*阈值/.test(lower)) return 'bike.threshold.v1';
  if (/甜区|sweet\s*spot/.test(lower)) return 'bike.sweet_spot.v1';
  if (/恢复跑|恢复.*跑/.test(lower)) return 'run.recovery.v1';
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
