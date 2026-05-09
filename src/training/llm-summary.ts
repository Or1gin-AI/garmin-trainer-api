// LLM-streamed weekly summary / monitoring / adjustmentRules (U9).
//
// Plain-text streaming with three section markers — ## 摘要 / ## 监控重点 /
// ## 调整规则. Section content is streamed via onDelta as fragments are
// produced; final assembled strings are returned for persistence.

import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { streamChat } from '../lib/llm.js';
import type { ScheduleResult } from './scheduler.js';
import type { ParameterizedWorkout } from './parameterizer.js';
import type { RecentState } from './recent-state.js';
import type { AthleteProfile } from './athlete-profile.js';
import type { ScheduleRequest } from './scheduler.js';

export type SummaryDeltaKind = 'summary' | 'monitoring' | 'adjustment_rules';

export interface LlmStreamSummaryArgs {
  schedule: ScheduleResult;
  workouts: ParameterizedWorkout[];
  recentState: RecentState;
  athleteProfile: AthleteProfile;
  request: ScheduleRequest;
  signal?: AbortSignal;
  onDelta: (delta: { kind: SummaryDeltaKind; text: string }) => void;
}

export interface LlmStreamSummaryResult {
  summary: string;
  monitoring: string;
  adjustmentRules: string;
  meta: { inputTokens: number; outputTokens: number };
}

const SECTION_HEADERS: Record<SummaryDeltaKind, string> = {
  summary: '## 摘要',
  monitoring: '## 监控重点',
  adjustment_rules: '## 调整规则',
};

// Header → kind, in the order they should appear.
const HEADER_TO_KIND: ReadonlyArray<readonly [string, SummaryDeltaKind]> = [
  ['## 摘要', 'summary'],
  ['## 监控重点', 'monitoring'],
  ['## 调整规则', 'adjustment_rules'],
];

export async function llmStreamSummary(
  args: LlmStreamSummaryArgs,
): Promise<LlmStreamSummaryResult> {
  const messages = buildMessages(args);

  const stream = await streamChat({
    messages,
    temperature: 0.6,
    signal: args.signal,
  });

  let buffer = '';
  let inputTokens = 0;
  let outputTokens = 0;

  // Section accumulators.
  const sections: Record<SummaryDeltaKind, string> = {
    summary: '',
    monitoring: '',
    adjustment_rules: '',
  };
  let currentKind: SummaryDeltaKind | null = null;
  // Carry an unflushed portion forward when a partial header may still be
  // forming — e.g. we've seen "## " but not yet "## 摘要".
  let pending = '';

  const flushIntoSection = (kind: SummaryDeltaKind, text: string): void => {
    if (text.length === 0) return;
    sections[kind] += text;
    args.onDelta({ kind, text });
  };

  const consumeChunk = (rawDelta: string): void => {
    pending += rawDelta;
    // Greedy parse: search for the next section header in pending. Anything
    // before it belongs to the current section; the header switches kind.
    while (pending.length > 0) {
      const headerMatch = findEarliestHeader(pending);
      if (!headerMatch) {
        // No header. If we currently have a kind, emit everything as-is —
        // unless the tail might be a partial header start. Hold back the
        // last `## ...` candidate so we don't split a header across boundaries.
        const safeIdx = lastSafeBoundary(pending);
        if (safeIdx > 0) {
          const emit = pending.slice(0, safeIdx);
          if (currentKind) flushIntoSection(currentKind, emit);
          pending = pending.slice(safeIdx);
        }
        return;
      }
      // Emit pre-header text into current section.
      const pre = pending.slice(0, headerMatch.index);
      if (currentKind) flushIntoSection(currentKind, pre);
      // Switch kind.
      currentKind = headerMatch.kind;
      // Consume header AND following newline if present.
      let cursor = headerMatch.index + headerMatch.header.length;
      if (pending[cursor] === '\n') cursor += 1;
      pending = pending.slice(cursor);
    }
  };

  for await (const chunk of stream) {
    if (args.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const choice = chunk.choices?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === 'string' && delta.length > 0) {
      buffer += delta;
      consumeChunk(delta);
    }
    const usage = chunk.usage;
    if (usage) {
      inputTokens = usage.prompt_tokens ?? inputTokens;
      outputTokens = usage.completion_tokens ?? outputTokens;
    }
  }

  // Flush any remaining pending content into the current section.
  if (pending.length > 0 && currentKind) {
    flushIntoSection(currentKind, pending);
    pending = '';
  }

  // If the model never emitted a header, treat the whole thing as the summary.
  if (
    sections.summary.length === 0 &&
    sections.monitoring.length === 0 &&
    sections.adjustment_rules.length === 0 &&
    buffer.length > 0
  ) {
    sections.summary = buffer;
    args.onDelta({ kind: 'summary', text: buffer });
  }

  return {
    summary: sections.summary.trim(),
    monitoring: sections.monitoring.trim(),
    adjustmentRules: sections.adjustment_rules.trim(),
    meta: { inputTokens, outputTokens },
  };
}

// ---------------------------------------------------------------------------
// Header parsing helpers
// ---------------------------------------------------------------------------

interface HeaderMatch {
  kind: SummaryDeltaKind;
  index: number;
  header: string;
}

function findEarliestHeader(text: string): HeaderMatch | null {
  let earliest: HeaderMatch | null = null;
  for (const [header, kind] of HEADER_TO_KIND) {
    const idx = text.indexOf(header);
    if (idx === -1) continue;
    if (earliest === null || idx < earliest.index) {
      earliest = { kind, index: idx, header };
    }
  }
  return earliest;
}

// Returns the largest prefix length we can safely emit without risking that
// a later chunk completes a header inside what we already emitted.
//
// Strategy: if the trailing 30 chars contain "##", hold from there forward.
function lastSafeBoundary(text: string): number {
  const tail = Math.min(40, text.length);
  const window = text.slice(text.length - tail);
  const idx = window.lastIndexOf('##');
  if (idx === -1) return text.length;
  return text.length - tail + idx;
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function buildMessages(args: LlmStreamSummaryArgs): ChatCompletionMessageParam[] {
  const systemParts: string[] = [];
  systemParts.push('你是一位中文运动教练，正在为用户撰写本周训练计划的总结说明。');
  systemParts.push('请按以下三个段落严格输出，每段以 "## 标题" 开头，段落之间用空行分隔：');
  systemParts.push(`${SECTION_HEADERS.summary}`);
  systemParts.push('（用 2-3 句中文概括本周课表：训练日数、各运动次数、是否含长距离/质量课，并提及当前疲劳/最新刺激。）');
  systemParts.push('');
  systemParts.push(`${SECTION_HEADERS.monitoring}`);
  systemParts.push('（2-4 句指出本周需要重点关注的指标：心率、主观疲劳、睡眠等，以及触发降级的条件。）');
  systemParts.push('');
  systemParts.push(`${SECTION_HEADERS.adjustment_rules}`);
  systemParts.push('（2-4 条规则，给出何时缩短训练、降低强度或全休的明确触发条件，每条 1-2 句。）');
  systemParts.push('');
  systemParts.push('禁止偏离上述结构、禁止增加新段落、禁止使用 Markdown 列表外的多级标题。');

  const userPayload = {
    request: {
      goal: args.request.goal ?? null,
      raceDate: args.request.raceDate ?? null,
      goalDistance: args.request.goalDistance ?? null,
      daysPerWeek: args.request.daysPerWeek,
      maxHardSessionsPerWeek: args.request.maxHardSessionsPerWeek,
    },
    athleteProfile: {
      experienceLevel: args.athleteProfile.experienceLevel,
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
    schedule: {
      notes: args.schedule.notes,
      days: args.schedule.days.map((d) => ({
        dayIndex: d.dayIndex,
        date: d.date,
        dayLabel: d.dayLabel,
        sport: d.sport,
        templateId: d.templateId,
        reason: d.reason ?? null,
      })),
    },
    workouts: args.workouts.map((w) => ({
      templateId: w.templateId,
      title: w.title,
      sport: w.sport,
      intensity: w.intensity,
      durationMinutes: w.durationMinutes,
      distanceKm: w.distanceKm,
      targetHeartRate: w.targetHeartRate,
      targetPace: w.targetPace,
      targetPower: w.targetPower,
    })),
  };

  return [
    { role: 'system', content: systemParts.join('\n') },
    {
      role: 'user',
      content: `请基于下列课表生成三段说明：\n\n${JSON.stringify(userPayload, null, 2)}`,
    },
  ];
}
