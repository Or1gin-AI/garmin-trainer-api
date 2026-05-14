import type { ScheduleEntry, ScheduleRequest } from './scheduler.js';
import { getTemplate, type Sport } from './templates/index.js';

export interface RequiredWorkout {
  templateId: string;
  count: number;
  raw: string;
}

export interface TrainingRequestIntent {
  requiredWorkouts: RequiredWorkout[];
  weeklyTargetMinutes: number | null;
  notes: string[];
}

interface WorkoutMatcher {
  templateIds: string[];
  pattern: RegExp;
  label: string;
}

const WORKOUT_MATCHERS: readonly WorkoutMatcher[] = [
  {
    templateIds: ['run.double_threshold_am.v1', 'run.double_threshold_pm.v1'],
    pattern: /双阈值|double\s*threshold/i,
    label: '双阈值',
  },
  {
    templateIds: ['run.reverse_pyramid.v1'],
    pattern: /倒金字塔|递减金字塔|反向金字塔|reverse\s*pyramid|inverted\s*pyramid/i,
    label: '倒金字塔',
  },
  {
    templateIds: ['run.vo2max.v1'],
    pattern: /(跑步|跑|run|running)?.{0,8}(vo2|max\s*oxygen|最大摄氧|vvo2)/i,
    label: '跑步 VO2max',
  },
  {
    templateIds: ['run.interval.v1'],
    pattern: /(短间歇|速度耐力|400\s*m|800\s*m|400米|800米|run.*interval|interval.*run|跑.*间歇|间歇跑)/i,
    label: '跑步间歇',
  },
  {
    templateIds: ['run.threshold.v1'],
    pattern: /(阈值跑|跑.*阈值|threshold\s*run|run.*threshold|zone\s*4|z4|hr\s*z4)/i,
    label: '阈值跑',
  },
  {
    templateIds: ['run.tempo.v1'],
    pattern: /(节奏跑|tempo\s*run|run.*tempo)/i,
    label: '节奏跑',
  },
  {
    templateIds: ['run.race_pace.v1'],
    pattern: /(马拉松专项|马配|比赛配速|race\s*pace|marathon\s*pace|\bmp\b)/i,
    label: '比赛配速专项',
  },
  {
    templateIds: ['run.progression.v1'],
    pattern: /(渐进跑|递进跑|progression\s*run|run.*progression)/i,
    label: '渐进跑',
  },
  {
    templateIds: ['run.strides.v1'],
    pattern: /(大步跑|加速跑|strides?)/i,
    label: '大步跑',
  },
  {
    templateIds: ['run.hill.v1'],
    pattern: /(上坡冲刺|坡冲|坡跑|hill\s*sprint|hill\s*run)/i,
    label: '上坡跑',
  },
  {
    templateIds: ['run.lsd.v1'],
    pattern: /\blsd\b|长距离跑|长跑|long\s*run/i,
    label: 'LSD',
  },
  {
    templateIds: ['run.aerobic.v1'],
    pattern: /(有氧跑|普通有氧|z2\s*run|zone\s*2\s*run|run.*zone\s*2)/i,
    label: '有氧跑',
  },
  {
    templateIds: ['bike.vo2max.v1'],
    pattern: /(骑行|骑|bike|cycling|ride).{0,8}(vo2|max\s*oxygen|最大摄氧)/i,
    label: '骑行 VO2max',
  },
  {
    templateIds: ['bike.sweet_spot.v1'],
    pattern: /甜区|sweet\s*spot/i,
    label: '甜区骑',
  },
  {
    templateIds: ['bike.threshold.v1'],
    pattern: /(阈值骑|骑.*阈值|bike.*threshold|cycling.*threshold|ftp.*阈值)/i,
    label: '阈值骑',
  },
  {
    templateIds: ['bike.over_under.v1'],
    pattern: /(over\s*under|criss\s*cross|阈值上下|交叉变强度)/i,
    label: '阈值上下浮动骑',
  },
  {
    templateIds: ['bike.anaerobic.v1'],
    pattern: /(30\/15|30-15|1min\s*间歇|1分钟间歇|无氧容量骑|anaerobic.*bike)/i,
    label: '骑行无氧间歇',
  },
  {
    templateIds: ['bike.climb.v1'],
    pattern: /(爬坡骑|低踏频|climb|爬坡专项)/i,
    label: '爬坡骑',
  },
  {
    templateIds: ['bike.sprint.v1'],
    pattern: /(冲刺骑|bike.*sprint|cycling.*sprint|骑.*冲刺)/i,
    label: '冲刺骑',
  },
  {
    templateIds: ['bike.long_ride.v1'],
    pattern: /(长骑|长距离骑|long\s*ride)/i,
    label: '长距离骑',
  },
  {
    templateIds: ['bike.endurance.v1'],
    pattern: /(z2\s*骑|zone\s*2\s*骑|耐力骑|有氧骑|bike.*zone\s*2)/i,
    label: 'Z2 耐力骑',
  },
  {
    templateIds: ['swim.css_threshold.v1'],
    pattern: /(阈值游|css|swim.*threshold|游.*阈值)/i,
    label: 'CSS 阈值游',
  },
  {
    templateIds: ['swim.vo2max.v1'],
    pattern: /(游泳|游|swim).{0,8}(vo2|max\s*oxygen|最大摄氧)/i,
    label: '游泳 VO2max',
  },
  {
    templateIds: ['swim.sprint.v1'],
    pattern: /(短冲游|50m\s*sprint|50米.*冲|swim.*sprint|游.*冲刺)/i,
    label: '短冲游',
  },
  {
    templateIds: ['swim.pull.v1'],
    pattern: /(划手|pull\b|pull\s*buoy)/i,
    label: '划手专项',
  },
  {
    templateIds: ['swim.kick.v1'],
    pattern: /(打腿|kick\b)/i,
    label: '打腿专项',
  },
  {
    templateIds: ['swim.endurance.v1'],
    pattern: /(长组耐力游|游泳lsd|长距离游|long\s*swim|swim.*endurance)/i,
    label: '长组耐力游',
  },
  {
    templateIds: ['swim.technique.v1'],
    pattern: /(技术游|drills?|游.*技术)/i,
    label: '技术游',
  },
];

export function extractTrainingRequestIntent(request: ScheduleRequest): TrainingRequestIntent {
  const text = [
    request.goal,
    request.notes,
    request.availableTime,
    ...(request.preferredKeyWorkoutDays ?? []),
  ]
    .filter(Boolean)
    .join('\n');
  const required = new Map<string, RequiredWorkout>();
  const notes: string[] = [];

  for (const matcher of WORKOUT_MATCHERS) {
    const match = matcher.pattern.exec(text);
    if (!match || match.index === undefined) continue;
    const count = inferRequestedCount(text, match.index);
    for (const templateId of matcher.templateIds) {
      if (!getTemplate(templateId)) continue;
      const prev = required.get(templateId);
      required.set(templateId, {
        templateId,
        count: Math.max(prev?.count ?? 0, count),
        raw: matcher.label,
      });
    }
  }

  const weeklyTargetMinutes = parseWeeklyTargetMinutes(text);
  if (weeklyTargetMinutes !== null) {
    notes.push(`用户显式给出周训练目标约 ${weeklyTargetMinutes} 分钟。`);
  }

  return {
    requiredWorkouts: Array.from(required.values()),
    weeklyTargetMinutes,
    notes,
  };
}

export function formatTrainingIntentForPrompt(intent: TrainingRequestIntent): string {
  const parts: string[] = [];
  if (intent.requiredWorkouts.length > 0) {
    parts.push(
      `必须出现的训练模板：${intent.requiredWorkouts
        .map((r) => `${r.templateId} x${r.count}（${r.raw}）`)
        .join('、')}`,
    );
  }
  if (intent.weeklyTargetMinutes !== null) {
    parts.push(`本周训练目标时长：约 ${intent.weeklyTargetMinutes} 分钟。`);
  }
  if (parts.length === 0) return '未识别到额外硬性用户意图。';
  return parts.join('\n');
}

export function missingRequiredWorkoutMessages(
  schedule: readonly ScheduleEntry[],
  intent: TrainingRequestIntent,
): string[] {
  const messages: string[] = [];
  for (const required of intent.requiredWorkouts) {
    const count = schedule.filter((entry) => entry.templateId === required.templateId).length;
    if (count < required.count) {
      messages.push(
        `${required.raw}: ${required.templateId} 需要 ${required.count} 次，当前 ${count} 次`,
      );
    }
  }
  return messages;
}

export function isTemplateEnabledByRequest(templateId: string, request: ScheduleRequest): boolean {
  const tpl = getTemplate(templateId);
  if (!tpl) return false;
  return isSportEnabled(tpl.fixed.sport, request);
}

function isSportEnabled(sport: Sport, request: ScheduleRequest): boolean {
  if (sport === 'rest' || sport === 'mobility' || sport === 'strength') return true;
  return request.sports[sport] === true;
}

function inferRequestedCount(text: string, index: number): number {
  const window = text.slice(Math.max(0, index - 14), Math.min(text.length, index + 14));
  if (/(三次|三堂|三节|3\s*(次|堂|节|x|×))/.test(window)) return 3;
  if (/(两次|二次|两堂|二堂|两节|二节|2\s*(次|堂|节|x|×))/.test(window)) return 2;
  return 1;
}

function parseWeeklyTargetMinutes(text: string): number | null {
  const minuteRe = /(\d{2,4})\s*(分钟|min|mins|minutes)/gi;
  let best: number | null = null;
  for (const match of text.matchAll(minuteRe)) {
    const raw = Number(match[1]);
    if (!Number.isFinite(raw) || raw <= 0) continue;
    const index = match.index ?? 0;
    const window = text.slice(Math.max(0, index - 24), Math.min(text.length, index + 24));
    if (isWeeklyDurationContext(window)) {
      best = clampWeeklyTarget(raw);
    }
  }

  const hourRe = /(\d{1,2}(?:\.\d+)?)\s*(小时|h|hours?)/gi;
  for (const match of text.matchAll(hourRe)) {
    const raw = Number(match[1]);
    if (!Number.isFinite(raw) || raw <= 0) continue;
    const index = match.index ?? 0;
    const window = text.slice(Math.max(0, index - 24), Math.min(text.length, index + 24));
    if (isWeeklyDurationContext(window)) {
      best = clampWeeklyTarget(Math.round(raw * 60));
    }
  }

  return best;
}

function isWeeklyDurationContext(window: string): boolean {
  return /(本周|这周|每周|周训练|weekly|week)/i.test(window) &&
    /(训练|时长|时间|总量|总时长|训练量|volume)/i.test(window);
}

function clampWeeklyTarget(minutes: number): number {
  return Math.max(15, Math.min(1200, Math.round(minutes)));
}
