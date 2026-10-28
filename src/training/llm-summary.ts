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
  summary: '## Summary',
  monitoring: '## Monitoring',
  adjustment_rules: '## Adjustment Rules',
};

// Header → kind, in the order they should appear. The legacy Chinese headers
// stay as aliases so a model that still answers with them is parsed correctly.
const HEADER_TO_KIND: ReadonlyArray<readonly [string, SummaryDeltaKind]> = [
  ['## Summary', 'summary'],
  ['## Monitoring', 'monitoring'],
  ['## Adjustment Rules', 'adjustment_rules'],
  ['## 摘要', 'summary'],
  ['## 监控重点', 'monitoring'],
  ['## 调整规则', 'adjustment_rules'],
];
const SUMMARY_STREAM_TIMEOUT_MS = 45_000;

export async function llmStreamSummary(
  args: LlmStreamSummaryArgs,
): Promise<LlmStreamSummaryResult> {
  const messages = buildMessages(args);

  const stream = await streamChat({
    messages,
    temperature: 0.6,
    timeoutMs: SUMMARY_STREAM_TIMEOUT_MS,
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
  systemParts.push('You are an endurance coach writing the summary notes for this week\'s training plan.');
  systemParts.push('Write ALL output in English, even if the user\'s goal or notes are written in another language.');
  systemParts.push('Output exactly the following three sections, each starting with its "## Heading" line, separated by a blank line:');
  systemParts.push(`${SECTION_HEADERS.summary}`);
  systemParts.push('(2-3 sentences summarizing the week: number of training days, sessions per sport, whether it includes long or quality sessions, and the current fatigue / latest training stimulus.)');
  systemParts.push('');
  systemParts.push(`${SECTION_HEADERS.monitoring}`);
  systemParts.push('(2-4 sentences on what to watch this week: heart rate, perceived fatigue, sleep, etc., and the conditions that should trigger a downgrade.)');
  systemParts.push('');
  systemParts.push(`${SECTION_HEADERS.adjustment_rules}`);
  systemParts.push('(2-4 rules with clear triggers for when to shorten a session, lower the intensity, or take a full rest day; 1-2 sentences each.)');
  systemParts.push('');
  systemParts.push('Do not deviate from this structure, do not add extra sections, and do not use any heading levels other than these three section headings (Markdown lists are fine).');
  systemParts.push('If you mention the number of quality or high-intensity sessions, you must use payload.metrics.highSessions; if you mention high-intensity training days, you must use payload.metrics.hardDays.');
  systemParts.push('When payload.metrics.forceRequestedSchedule=true the user\'s request takes priority: do not say the system removed or overrode the user\'s request; only describe the risks, what to monitor, and the conditions for scaling back during execution.');

  const metrics = buildPlanMetrics(args);
  const userPayload = {
    metrics,
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
      content: `Write the three sections in English for the following weekly plan:\n\n${JSON.stringify(userPayload, null, 2)}`,
    },
  ];
}

function buildPlanMetrics(args: LlmStreamSummaryArgs) {
  const highSessions = args.workouts.filter((w) => w.intensity === 'high').length;
  const hardDayIndexes = new Set<number>();
  let activeSessions = 0;
  for (let i = 0; i < args.workouts.length; i += 1) {
    const workout = args.workouts[i];
    const entry = args.schedule.days[i];
    if (workout.sport !== 'rest' && workout.sport !== 'mobility') {
      activeSessions += 1;
    }
    if (workout.intensity === 'high') {
      hardDayIndexes.add(entry?.dayIndex ?? i + 1);
    }
  }
  const hardDays = Array.from(hardDayIndexes).sort((a, b) => a - b);
  const consecutiveHardDayPairs: Array<[number, number]> = [];
  for (let i = 1; i < hardDays.length; i += 1) {
    if (hardDays[i] === hardDays[i - 1] + 1) {
      consecutiveHardDayPairs.push([hardDays[i - 1], hardDays[i]]);
    }
  }
  const maxHardSessionsPerWeek = args.request.maxHardSessionsPerWeek ?? null;
  return {
    activeSessions,
    highSessions,
    hardDays: hardDays.length,
    hardDayIndexes: hardDays,
    consecutiveHardDayPairs,
    maxHardSessionsPerWeek,
    hardSessionsLast7d: args.recentState.hardSessionsLast7d,
    fatigue: args.recentState.fatigue,
    forceRequestedSchedule: args.request.forceRequestedSchedule === true,
    overRequestedHardCap:
      maxHardSessionsPerWeek !== null ? hardDays.length > maxHardSessionsPerWeek : false,
  };
}
