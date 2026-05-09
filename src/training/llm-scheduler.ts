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
import { streamChat, getActiveLlmConfig } from '../lib/llm.js';
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
  recentState: RecentState;
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

  const { request, athleteProfile, recentState } = args;

  // Build per-sport allowed catalog (post-contraindication filter).
  const enabledSports = collectEnabledSports(request);
  const allowedIds = new Set<string>();
  const catalogLines: string[] = [];

  for (const sport of enabledSports) {
    const allowed = filterAllowedTemplates({
      sport,
      athleteProfile: filterAthleteProfile(athleteProfile),
      recentState: filterRecentState(recentState),
      request: {
        sports: request.sports as Partial<Record<Sport, boolean>>,
        maxHardSessionsPerWeek: request.maxHardSessionsPerWeek ?? undefined,
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

  // Always allow rest templates.
  for (const tpl of Object.values(WORKOUT_TEMPLATES)) {
    if (tpl.fixed.sport === 'rest' || tpl.fixed.sport === 'mobility') {
      allowedIds.add(tpl.id);
    }
  }
  const restCatalog = getCatalogForPrompt(['rest', 'mobility']);
  if (restCatalog) catalogLines.push(restCatalog);

  const messages = buildMessages({
    request,
    athleteProfile,
    recentState,
    catalog: catalogLines.join('\n'),
    retryViolations: args.retryViolations,
  });

  const tools: ChatCompletionTool[] = [
    {
      type: 'function',
      function: {
        name: TOOL_NAME,
        description:
          '从允许的模板列表中为本周 7 天各选 1 个 templateId，并附中文 reason。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['days'],
          properties: {
            days: {
              type: 'array',
              minItems: 7,
              maxItems: 7,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['dayIndex', 'sport', 'templateId', 'reason'],
                properties: {
                  dayIndex: { type: 'integer', minimum: 1, maximum: 7 },
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

  // Stream + accumulate tool-call argument deltas. Most OpenAI-compatible
  // providers emit the tool args as a series of `delta.tool_calls[i].function
  // .arguments` JSON-fragment strings; we concat then JSON.parse once at the end.
  const stream = await streamChat({
    messages,
    tools,
    toolChoice: { type: 'function', function: { name: TOOL_NAME } },
    temperature: 0.4,
    signal: args.signal,
  });

  let argsBuffer = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let sawToolCall = false;

  for await (const chunk of stream) {
    if (args.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const choice = chunk.choices?.[0];
    const toolCalls = choice?.delta?.tool_calls;
    if (toolCalls && toolCalls.length > 0) {
      for (const tc of toolCalls) {
        const piece = tc.function?.arguments;
        if (typeof piece === 'string' && piece.length > 0) {
          argsBuffer += piece;
          sawToolCall = true;
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

  if (!sawToolCall || argsBuffer.length === 0) {
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
}

function validateAndBuildResult(args: ValidateArgs): ScheduleResult {
  const violations: string[] = [];
  const { parsed, request, allowedIds, athleteProfile, recentState } = args;

  if (!Array.isArray(parsed.days)) {
    throw new InvalidLlmScheduleError(['days is not an array']);
  }
  if (parsed.days.length !== 7) {
    violations.push(`days.length=${parsed.days.length}, expected 7`);
  }

  const seenDayIndexes = new Set<number>();
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
    if (seenDayIndexes.has(day.dayIndex)) {
      violations.push(`duplicate dayIndex ${day.dayIndex}`);
      continue;
    }
    seenDayIndexes.add(day.dayIndex);

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

    if (tpl.fixed.sport !== day.sport) {
      violations.push(
        `day ${day.dayIndex}: template ${day.templateId} sport=${tpl.fixed.sport} != claimed sport=${day.sport}`,
      );
      continue;
    }

    // Re-check filter for the template's actual sport. This catches any
    // template the LLM picked outside the catalog or that contraindications
    // would block now.
    if (!allowedIds.has(day.templateId)) {
      violations.push(
        `day ${day.dayIndex}: template ${day.templateId} not in allowed catalog`,
      );
      continue;
    }

    entries.push({
      dayIndex: day.dayIndex,
      date: addDays(request.weekStartDate, day.dayIndex - 1),
      dayLabel: DAY_LABELS[day.dayIndex - 1] ?? '',
      sport: tpl.fixed.sport,
      templateId: day.templateId,
      reason: typeof day.reason === 'string' ? day.reason : undefined,
    });
  }

  if (entries.length !== 7) {
    violations.push(`only ${entries.length}/7 days valid`);
  }

  // Hard-rule: no two consecutive intensity=high.
  const sortedEntries = entries.slice().sort((a, b) => a.dayIndex - b.dayIndex);
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

  // Hard-rule: hard-cap.
  const HARD_STIMULI = new Set(['threshold', 'vo2max', 'anaerobic']);
  const hardCap = computeHardCap(request, athleteProfile, recentState);
  const hardCount = sortedEntries.filter(
    (e) => getTemplate(e.templateId)?.fixed.intensity === 'high',
  ).length;
  if (hardCount > hardCap) {
    violations.push(`hard count ${hardCount} > cap ${hardCap}`);
  }

  // Hard-rule: no high intensity within 36h of a recent threshold/vo2/anaerobic.
  const hoursAgo = hoursSinceLatest(recentState);
  if (
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
  recentState: RecentState;
  catalog: string;
  retryViolations?: string[];
}

function buildMessages(args: BuildMessagesArgs): ChatCompletionMessageParam[] {
  const systemParts: string[] = [];
  systemParts.push(
    '你是一位专业的运动教练，正在为用户安排 7 天训练计划。所有训练动作只能从下列允许的模板中选择 templateId，不允许编造模板 id 或参数。',
  );
  systemParts.push(
    '硬性规则：',
  );
  systemParts.push('- 必须输出且仅输出 7 天 (dayIndex 1..7)；');
  systemParts.push('- 每个非休息日必须给出一个允许列表中的 templateId；');
  systemParts.push('- 任意相邻两天不得同时为 intensity=high 的训练；');
  systemParts.push(
    `- 本周高强度课不得超过 ${computeHardCap(
      args.request,
      args.athleteProfile,
      args.recentState,
    )} 次；`,
  );
  systemParts.push(
    '- 若最近 36 小时内有 threshold/vo2max/anaerobic 训练，第 1 天不得安排高强度课；',
  );
  systemParts.push(
    '- sport 字段必须与所选 templateId 对应模板的 sport 一致；',
  );
  systemParts.push(
    '- 休息日请使用 rest 类模板（rest.full.v1 / rest.mobility.v1）。',
  );
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
    injuries: args.request.injuries ?? null,
    notes: args.request.notes ?? null,
    sports: args.request.sports,
    sportPriorities: args.request.sportPriorities ?? null,
    maxHardSessionsPerWeek: args.request.maxHardSessionsPerWeek,
    targetMetricPreference: args.request.targetMetricPreference,
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

function filterAthleteProfile(p: AthleteProfile) {
  return {
    injuries: p.injuries,
    experienceLevel: p.experienceLevel,
    running: { confidence: p.running.confidence },
    cycling: {
      confidence: p.cycling.confidence,
      ftpWatts: p.cycling.ftpWatts ?? null,
    },
    swimming: { confidence: p.swimming.confidence },
  };
}

function filterRecentState(state: RecentState) {
  return {
    latestStimulus: state.latestStimulus === 'unknown' ? null : state.latestStimulus,
    fatigue: state.fatigue === 'fresh' ? 'normal' as const : state.fatigue,
  };
}

function computeHardCap(
  request: ScheduleRequest,
  athleteProfile: AthleteProfile,
  recentState: RecentState,
): number {
  const base = request.maxHardSessionsPerWeek ?? 2;
  if (
    athleteProfile.experienceLevel === 'advanced' &&
    (recentState.fatigue === 'fresh' || recentState.fatigue === 'normal')
  ) {
    return Math.min(base, 3);
  }
  return Math.min(base, 2);
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
