// Centralizes Chinese display names and summary builders for the `tool_event`
// SSE channel. Both the orchestrator (plan generation) and the chat route
// dispatch through these helpers so the frontend always shows consistent,
// user-facing labels — never raw tool names or arg JSON.

import type { Violation } from './validation.js';

export const TOOL_DISPLAY: Record<string, string> = {
  // Plan-generation pseudo tools.
  load_recent_activities: '查询近 56 天国区 Garmin 训练记录',
  load_athlete_profile: '分析跑者画像与近期状态',
  llm_build_schedule: '编排本周训练日程',
  llm_parameterize_workout: '配置训练课参数',
  validate_plan: '校验训练负荷',
  llm_stream_summary: '生成本周总结与监测建议',

  // Real chat tools.
  regenerate_day: '重新生成训练课',
  add_second_workout: '新增第二堂训练课',
  update_workout_field: '更新训练状态',
};

const SPORT_ZH: Record<string, string> = {
  running: '跑步',
  cycling: '骑行',
  swimming: '游泳',
  rest: '休息',
  mobility: '活动恢复',
  strength: '力量',
};

const STATUS_ZH: Record<string, string> = {
  completed: '已完成',
  skipped: '已跳过',
  planned: '计划中',
};

export function dayDisplay(dayIndex: number, sport?: string): string {
  const dayLabel = `第 ${dayIndex} 天`;
  if (sport) {
    const zh = SPORT_ZH[sport] ?? sport;
    return `${dayLabel} · ${zh}`;
  }
  return dayLabel;
}

export function summarizeParameterized(
  source: 'llm' | 'fallback' | 'rest',
  workout: {
    title?: string;
    durationMinutes?: number | null;
    distanceKm?: number | null;
    targetPace?: string;
    targetHeartRate?: string;
  },
): string {
  if (source === 'rest') return '休息日，无需 LLM 参数化';
  const parts: string[] = [];
  if (workout.title) parts.push(workout.title);
  if (workout.distanceKm != null && Number.isFinite(workout.distanceKm)) {
    parts.push(`${Number(workout.distanceKm).toFixed(1)}km`);
  } else if (workout.durationMinutes != null) {
    parts.push(`${workout.durationMinutes} 分钟`);
  }
  if (workout.targetPace && workout.targetPace !== '不适用') {
    parts.push(workout.targetPace);
  } else if (workout.targetHeartRate && workout.targetHeartRate !== '不适用') {
    parts.push(workout.targetHeartRate);
  }
  const head = source === 'fallback' ? '已用模板默认值 · ' : '';
  return head + (parts.join(' · ') || '已生成');
}

export function summarizeValidation(violations: Violation[]): string {
  if (violations.length === 0) return '无冲突';
  return `检出 ${violations.length} 处冲突，已自动降级处理`;
}

export function summarizeSchedule(
  source: 'llm' | 'deterministic',
  daysCount: number,
  sportCounts: Record<string, number>,
): string {
  const parts = Object.entries(sportCounts)
    .filter(([, n]) => n > 0)
    .map(([sport, n]) => `${n} 次${SPORT_ZH[sport] ?? sport}`)
    .join(' + ');
  const head = source === 'deterministic' ? '已回退到规则引擎 · ' : '';
  return head + `${daysCount} 天日程（${parts || '以休息为主'}）`;
}

export function summarizeRegenerateDay(dayIndex: number, sport: string): string {
  const zh = SPORT_ZH[sport] ?? sport;
  return `已为第 ${dayIndex} 天生成${zh}训练`;
}

export function summarizeAddSecondWorkout(dayIndex: number, sport: string): string {
  const zh = SPORT_ZH[sport] ?? sport;
  return `已为第 ${dayIndex} 天新增${zh}第二练`;
}

export function summarizeUpdateStatus(value: string): string {
  return `状态已设为：${STATUS_ZH[value] ?? value}`;
}
