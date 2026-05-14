// Deterministic 7-day workout scheduler (U7).
//
// Pure function: takes a ScheduleRequest + AthleteProfile + RecentState and
// emits a 7-entry schedule of {dayIndex, date, sport, templateId}. No LLM,
// no I/O, no mutation. The contracts (input/output shapes) are FROZEN — U9
// will swap the body of buildWeeklySchedule for an LLM call but must keep
// the same signature.
//
// Algorithm (rough):
//   1. Decide rest-day positions from daysPerWeek + preferredRestDay.
//   2. Walk training days, picking a sport per day (rotating through enabled
//      sports, respecting sportPriorities, avoiding 3-in-a-row when multiple
//      sports are on).
//   3. For each (day, sport) consult filterAllowedTemplates from U5 and pick
//      a template based on:
//        - recentState fatigue / latestStimulus (force recovery / aerobic
//          when the body needs it)
//        - hard-session cap (max 2/wk normally, 3 if advanced + fresh)
//        - goal-driven (race-pace / threshold once per week when running and
//          a race is within 12 weeks)
//        - long run / long ride once per week when feasible
//        - default rotation (aerobic / tempo / threshold / interval / vo2max)
//   4. Sanity pass: never two high-intensity days in a row, never exceed the
//      hard cap. Swap offending days down to aerobic.
//   5. Return ScheduleResult with reasons + top-level notes.
//
// Determinism: every decision should be reproducible from the same inputs.
// We deliberately avoid Math.random.

import type { AthleteProfile } from './athlete-profile.js';
import type { RecentState } from './recent-state.js';
import {
  filterAllowedTemplates,
  getTemplate,
  type WorkoutTemplate,
  type Sport,
} from './templates/index.js';
import { DEFAULT_MAX_HARD_SESSIONS_PER_WEEK } from './templates/variables.js';
import {
  getCapacityDurationCap,
  type TrainingCapacity,
} from './training-capacity.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ActiveSport = 'running' | 'cycling' | 'swimming';

export interface ScheduleRequest {
  weekStartDate: string; // 'YYYY-MM-DD' for Monday
  goal?: string;
  raceDate?: string | null;
  goalDistance?: string | null;
  daysPerWeek: number; // 1-7
  preferredRestDay?: string; // 'monday'..'sunday' or empty
  availableTime?: string; // free text
  injuries?: string;
  notes?: string;
  sports: Record<ActiveSport, boolean>; // {running, cycling, swimming}
  sportPriorities?: Sport[]; // optional ordering
  preferredKeyWorkoutDays?: string[];
  preferredTrainingWindows?: string[];
  dailyPreferredMinutes?: number | null;
  weeklyMaxMinutes?: number | null;
  expectedLoad?: number | null;
  allowAdvancedWorkouts?: boolean;
  allowDoubleDays?: boolean;
  forceRequestedSchedule?: boolean;
  exportFormats?: Array<'intervals_icu' | 'word' | 'pdf' | 'excel'>;
  maxHardSessionsPerWeek: number | null;
  targetMetricPreference: 'auto' | 'heart_rate' | 'pace';
}

export interface ScheduleEntry {
  dayIndex: number; // 1..7 (1 = Monday for the weekStartDate)
  date: string; // 'YYYY-MM-DD'
  dayLabel: string; // '周一' to '周日'
  sport: Sport;
  templateId: string;
  slotIndex?: number; // 1 = first session, 2 = second session on same date.
  sessionLabel?: string;
  timeOfDay?: 'morning' | 'midday' | 'afternoon' | 'evening';
  reason?: string;
  durationCapMinutes?: number;
  durationCapReason?: string;
}

export interface ScheduleResult {
  days: ScheduleEntry[]; // normally 7 entries; can exceed 7 for double days.
  notes: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAY_LABELS: readonly string[] = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

const DAY_NAME_TO_INDEX: Record<string, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
};

const DAY_REFERENCE_PATTERNS: ReadonlyArray<{ dayIndex: number; pattern: RegExp }> = [
  { dayIndex: 1, pattern: /(周一|星期一|礼拜一|\bmonday\b|\bmon\b|第\s*1\s*天|day\s*1)/gi },
  { dayIndex: 2, pattern: /(周二|星期二|礼拜二|\btuesday\b|\btue\b|第\s*2\s*天|day\s*2)/gi },
  { dayIndex: 3, pattern: /(周三|星期三|礼拜三|\bwednesday\b|\bwed\b|第\s*3\s*天|day\s*3)/gi },
  { dayIndex: 4, pattern: /(周四|星期四|礼拜四|\bthursday\b|\bthu\b|第\s*4\s*天|day\s*4)/gi },
  { dayIndex: 5, pattern: /(周五|星期五|礼拜五|\bfriday\b|\bfri\b|第\s*5\s*天|day\s*5)/gi },
  { dayIndex: 6, pattern: /(周六|星期六|礼拜六|\bsaturday\b|\bsat\b|第\s*6\s*天|day\s*6)/gi },
  { dayIndex: 7, pattern: /(周日|周天|星期日|星期天|礼拜日|礼拜天|\bsunday\b|\bsun\b|第\s*7\s*天|day\s*7)/gi },
];

const TRAINING_DAY_INTENT_RE =
  /(训练|跑步|跑|骑行|骑车|骑|游泳|游|加练|两练|双练|双课|第二练|质量课|长跑|长骑|有空|可训练|可以训练|安排|not\s*rest|don'?t\s*rest|no\s*rest|train|workout|session|run|ride|bike|cycle|swim)/i;

const REST_INTENT_RE = /(休息|不练|没空|不可训练|不能训练|\brest\b|\boff\b)/i;
const NEGATED_REST_INTENT_RE = /(不|别|不要|不能|不可|no|not|don'?t)\s*(安排)?\s*(休息|rest|off)/i;

const HARD_STIMULI: ReadonlySet<string> = new Set(['threshold', 'vo2max', 'anaerobic']);
export const MAX_WEEKLY_TRAINING_MINUTES = 1200;

// Default rest-day arrangement (1-indexed) for each daysPerWeek.
// Spec: rest day is preferred on Monday (recovery from weekend) and Sunday
// (planning day). When 6 days/week we drop to just Monday rest.
const DEFAULT_REST_DAYS_BY_DPW: Record<number, number[]> = {
  1: [1, 2, 3, 4, 6, 7], // 6 rest days, training only Friday by default
  2: [1, 3, 5, 6, 7],
  3: [1, 3, 5, 7],
  4: [1, 3, 7],
  5: [1, 7],
  6: [1],
  7: [],
};

// Default sport rotation order when no priorities given.
const DEFAULT_SPORT_ORDER: ActiveSport[] = ['running', 'cycling', 'swimming'];

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface BuildScheduleArgs {
  request: ScheduleRequest;
  athleteProfile: AthleteProfile;
  recentState: RecentState;
  trainingCapacity?: TrainingCapacity;
}

export function buildWeeklySchedule(args: BuildScheduleArgs): ScheduleResult {
  const { request, athleteProfile, recentState, trainingCapacity } = args;
  const forceRequestedSchedule = request.forceRequestedSchedule === true;

  const enabledSports = getEnabledSports(request);
  const notes: string[] = [];

  if (enabledSports.length === 0) {
    // Nothing enabled — fall back to a fully-rest week.
    notes.push('未选择任何运动，本周安排完全休息。');
    return {
      days: buildAllRestWeek(request.weekStartDate, recentState, trainingCapacity),
      notes,
    };
  }

  const requestedDaysPerWeek = normalizeDaysPerWeek(request.daysPerWeek);
  const protectedTrainingDays = requestedTrainingDayIndexes(request);
  const daysPerWeek = Math.max(requestedDaysPerWeek, protectedTrainingDays.size);
  if (protectedTrainingDays.size > 0) {
    notes.push(
      `用户指定训练日 ${formatDayIndexes(protectedTrainingDays)} 已锁定为训练日，不会被默认休息日覆盖。`,
    );
    if (protectedTrainingDays.size > requestedDaysPerWeek) {
      notes.push(
        `用户指定训练日数量 ${protectedTrainingDays.size} 天超过每周训练天数 ${requestedDaysPerWeek} 天，已优先按指定训练日生成。`,
      );
    }
  }
  const restDays = decideRestDays(daysPerWeek, request.preferredRestDay, protectedTrainingDays);

  const trainingDayIndexes = [1, 2, 3, 4, 5, 6, 7].filter(
    (d) => !restDays.includes(d),
  );

  const sportOrder = decideSportOrder(request, enabledSports);
  const dayToSport = assignSports(trainingDayIndexes, sportOrder);

  // Effective hard-session cap. If the user supplied a cap, treat it as their
  // requested boundary instead of silently shrinking it with defaults.
  const userHardCap = request.maxHardSessionsPerWeek;
  const baseCap = userHardCap ?? DEFAULT_MAX_HARD_SESSIONS_PER_WEEK;
  let hardCap =
    userHardCap !== null && userHardCap !== undefined
      ? clamp(Math.round(userHardCap), 0, 7)
      : Math.min(baseCap, athleteProfile.experienceLevel === 'advanced' ? 3 : 2);
  if (trainingCapacity) {
    notes.push(...trainingCapacity.guardrails.notes);
    const capacityCap = trainingCapacity.guardrails.maxHardSessionsPerWeek;
    if (forceRequestedSchedule || (userHardCap !== null && userHardCap !== undefined)) {
      if (capacityCap < hardCap) {
        notes.push(
          `用户要求高强度上限 ${hardCap} 次；系统未应用容量建议上限 ${capacityCap} 次，只保留风险提示。`,
        );
      }
    } else {
      if (capacityCap < hardCap) {
        notes.push(
          `由于恢复/训练容量评估，本周未按原高强度要求生成，已从 ${hardCap} 次降至 ${capacityCap} 次。`,
        );
      }
      hardCap = Math.min(hardCap, capacityCap);
    }
  }
  notes.push(`本周高强度课上限 ${hardCap} 次。`);

  if (HARD_STIMULI.has(recentState.latestStimulus)) {
    const hoursAgo = hoursSince(recentState);
    if (hoursAgo !== null && hoursAgo < 36) {
      notes.push(
        forceRequestedSchedule
          ? `近 36 小时内有 ${recentState.latestStimulus} 刺激；系统按用户要求生成，仅保留风险提示。`
          : `近 36 小时内有 ${recentState.latestStimulus} 刺激，本周开局优先恢复。`,
      );
    }
  }
  if (recentState.fatigue === 'high_risk') {
    notes.push(
      forceRequestedSchedule
        ? '近期负荷偏高；系统按用户要求生成，不因恢复风险自动删减训练日。'
        : '近期负荷偏高，本周以恢复和低强度有氧为主。',
    );
  } else if (recentState.fatigue === 'tired') {
    notes.push(
      forceRequestedSchedule
        ? '已有疲劳；系统按用户要求生成，不因疲劳自动改掉首个训练日。'
        : '已有疲劳，本周第一次训练以轻松课开局。',
    );
  }
  if (request.dailyPreferredMinutes && request.dailyPreferredMinutes > 0) {
    notes.push(`单日可用时间上限 ${request.dailyPreferredMinutes} 分钟；系统不会为凑满时长而拉长质量课。`);
  }
  notes.push(`本周总训练时长上限 ${request.weeklyMaxMinutes ?? MAX_WEEKLY_TRAINING_MINUTES} 分钟。`);
  if (request.preferredTrainingWindows && request.preferredTrainingWindows.length > 0) {
    notes.push(`优先使用偏好时段：${request.preferredTrainingWindows.join('、')}。`);
  }

  // First pass: pick templates per training day.
  const days = new Array<ScheduleEntry | null>(7).fill(null);
  let hardScheduled = 0;
  let longRunScheduled = false;
  let longRideScheduled = false;
  let racePaceScheduled = false;

  const wantsRacePace = shouldIncludeRacePace(request);

  // First training-day flag — used for the "tired => start with aerobic" rule.
  let firstTrainingHandled = false;

  for (const dayIndex of [1, 2, 3, 4, 5, 6, 7]) {
    if (restDays.includes(dayIndex)) continue;
    const sport = dayToSport.get(dayIndex);
    if (!sport) continue;

    const isFirstTraining = !firstTrainingHandled;
    firstTrainingHandled = true;

    const prevEntry = dayIndex > 1 ? days[dayIndex - 2] : null;
    const prevIntensityHigh = prevEntry
      ? templateIntensity(prevEntry.templateId) === 'high'
      : false;

    const pick = pickTemplateForDay({
      dayIndex,
      sport,
      isFirstTraining,
      prevIntensityHigh,
      hardScheduled,
      hardCap,
      longRunScheduled,
      longRideScheduled,
      racePaceScheduled,
      wantsRacePace,
      athleteProfile,
      recentState,
      request,
      forceRequestedSchedule,
    });

    const entry: ScheduleEntry = {
      dayIndex,
      date: addDays(request.weekStartDate, dayIndex - 1),
      dayLabel: DAY_LABELS[dayIndex - 1],
      sport,
      templateId: pick.templateId,
      slotIndex: 1,
      timeOfDay: chooseTimeOfDay(request, dayIndex),
      reason: pick.reason,
    };
    applyDurationCap(entry, forceRequestedSchedule ? undefined : trainingCapacity);
    days[dayIndex - 1] = entry;

    if (pick.intensity === 'high') hardScheduled += 1;
    if (pick.templateId === 'run.lsd.v1') longRunScheduled = true;
    if (pick.templateId === 'bike.long_ride.v1') longRideScheduled = true;
    if (pick.templateId === 'run.race_pace.v1') racePaceScheduled = true;
  }

  // Fill rest days.
  for (const dayIndex of restDays) {
    days[dayIndex - 1] = buildRestEntry(
      dayIndex,
      request.weekStartDate,
      recentState,
      trainingCapacity,
    );
  }

  // Sanity pass: drop consecutive-hard violations and over-cap.
  applySanityPass(days, hardCap, notes, forceRequestedSchedule);

  return {
    days: days.map((d) => d!).slice(0, 7),
    notes,
  };
}

// ---------------------------------------------------------------------------
// Sport selection
// ---------------------------------------------------------------------------

function getEnabledSports(request: ScheduleRequest): ActiveSport[] {
  const out: ActiveSport[] = [];
  if (request.sports.running) out.push('running');
  if (request.sports.cycling) out.push('cycling');
  if (request.sports.swimming) out.push('swimming');
  return out;
}

function decideSportOrder(
  request: ScheduleRequest,
  enabled: ActiveSport[],
): ActiveSport[] {
  const inEnabled = (s: Sport): s is ActiveSport =>
    s === 'running' || s === 'cycling' || s === 'swimming';

  if (request.sportPriorities && request.sportPriorities.length > 0) {
    const priorityList: ActiveSport[] = [];
    for (const s of request.sportPriorities) {
      if (inEnabled(s) && enabled.includes(s) && !priorityList.includes(s)) {
        priorityList.push(s);
      }
    }
    // Append any enabled sports not in the priority list.
    for (const s of enabled) {
      if (!priorityList.includes(s)) priorityList.push(s);
    }
    if (priorityList.length > 0) return priorityList;
  }
  // Default: use canonical order filtered by enabled set.
  return DEFAULT_SPORT_ORDER.filter((s) => enabled.includes(s));
}

// Assign sports to training days. Soft rule: avoid 3-in-a-row of same sport
// when more than one sport is enabled. Cycle through the order; if the last
// two days were same sport, skip ahead to a different one.
function assignSports(
  trainingDayIndexes: number[],
  order: ActiveSport[],
): Map<number, ActiveSport> {
  const result = new Map<number, ActiveSport>();
  if (order.length === 0) return result;

  let cursor = 0;
  let lastSport: ActiveSport | null = null;
  let runLength = 0;

  for (const dayIndex of trainingDayIndexes) {
    let sport = order[cursor % order.length];
    if (
      order.length > 1 &&
      lastSport === sport &&
      runLength >= 2
    ) {
      // Step to a different sport.
      cursor += 1;
      sport = order[cursor % order.length];
    }
    result.set(dayIndex, sport);
    if (sport === lastSport) {
      runLength += 1;
    } else {
      runLength = 1;
      lastSport = sport;
    }
    cursor += 1;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Rest-day positioning
// ---------------------------------------------------------------------------

function decideRestDays(
  daysPerWeek: number,
  preferredRestDayName: string | undefined,
  protectedTrainingDays: Set<number> = new Set(),
): number[] {
  const defaults = DEFAULT_REST_DAYS_BY_DPW[daysPerWeek] ?? [];

  const preferred = preferredRestDayName
    ? DAY_NAME_TO_INDEX[preferredRestDayName.toLowerCase()] ?? null
    : null;

  let restDays: number[];
  if (preferred && !defaults.includes(preferred)) {
    // Replace one of the default rest days with the preferred one if needed.
    if (defaults.length === 0) {
      // 7-day plan — no rest day by default; ignore preferred.
      return [];
    }
    const replacement = [...defaults];
    replacement[0] = preferred;
    restDays = Array.from(new Set(replacement));
  } else {
    restDays = defaults.slice();
  }

  if (protectedTrainingDays.size > 0) {
    const replacementOrder = [5, 3, 7, 1, 2, 4, 6];
    for (const protectedDay of protectedTrainingDays) {
      if (!restDays.includes(protectedDay)) continue;
      restDays = restDays.filter((d) => d !== protectedDay);
      const replacement = replacementOrder.find(
        (d) => !restDays.includes(d) && !protectedTrainingDays.has(d),
      );
      if (replacement !== undefined) {
        restDays.push(replacement);
      }
    }
  }

  return Array.from(new Set(restDays)).sort((a, b) => a - b);
}

export function requestedDoubleDayIndex(request: ScheduleRequest): number | null {
  if (request.allowDoubleDays !== true) return null;
  const text = [request.goal, request.notes, request.availableTime]
    .filter(Boolean)
    .join('\n');
  if (!/(一天两练|一日两练|同日两练|双练|双课|第二练|加练|double\s*(day|session|workout)|two-a-day|2\s*(workouts|sessions))/i.test(text)) {
    return null;
  }
  const day = firstDayIndexInText(text);
  if (day !== null) return day;
  return null;
}

export function requestedTrainingDayIndexes(request: ScheduleRequest): Set<number> {
  const days = new Set<number>();

  const doubleDay = requestedDoubleDayIndex(request);
  if (doubleDay !== null) days.add(doubleDay);

  for (const raw of request.preferredKeyWorkoutDays ?? []) {
    const day = firstDayIndexInText(raw);
    if (day !== null) days.add(day);
  }

  const text = [request.goal, request.notes, request.availableTime]
    .filter(Boolean)
    .join('\n');
  if (!text) return days;

  for (const spec of DAY_REFERENCE_PATTERNS) {
    spec.pattern.lastIndex = 0;
    for (const match of text.matchAll(spec.pattern)) {
      const index = match.index ?? 0;
      const around = text.slice(Math.max(0, index - 8), index + match[0].length + 18);
      const forward = text.slice(index, index + match[0].length + 18);
      if (NEGATED_REST_INTENT_RE.test(around) || hasTrainingIntent(forward)) {
        days.add(spec.dayIndex);
      }
    }
  }

  return days;
}

// ---------------------------------------------------------------------------
// Per-day template pick
// ---------------------------------------------------------------------------

interface PickInput {
  dayIndex: number;
  sport: ActiveSport;
  isFirstTraining: boolean;
  prevIntensityHigh: boolean;
  hardScheduled: number;
  hardCap: number;
  longRunScheduled: boolean;
  longRideScheduled: boolean;
  racePaceScheduled: boolean;
  wantsRacePace: boolean;
  athleteProfile: AthleteProfile;
  recentState: RecentState;
  request: ScheduleRequest;
  forceRequestedSchedule: boolean;
}

interface PickOutput {
  templateId: string;
  reason: string;
  intensity: 'low' | 'medium' | 'high';
}

function pickTemplateForDay(input: PickInput): PickOutput {
  const allowed = filterAllowedTemplates({
    sport: input.sport,
    athleteProfile: filterAthleteProfileForScheduling(
      input.athleteProfile,
      input.forceRequestedSchedule,
    ),
    recentState: filterRecentStateForScheduling(
      input.recentState,
      input.forceRequestedSchedule,
    ),
    request: {
      sports: input.request.sports as Partial<Record<Sport, boolean>>,
      maxHardSessionsPerWeek: input.hardCap,
      allowAdvancedWorkouts: input.request.allowAdvancedWorkouts,
    },
    hardSessionsAlreadyScheduledThisWeek: input.hardScheduled,
  });
  const allowedIds = new Set(allowed.map((t) => t.id));

  // Hard recovery rule: if recentState.fatigue is high_risk AND we're in the
  // first 2 training days of the week, force recovery.
  if (
    !input.forceRequestedSchedule &&
    input.recentState.fatigue === 'high_risk' &&
    input.dayIndex <= 2
  ) {
    return forceRecovery(input.sport, allowedIds, '近期高风险疲劳，先做恢复。');
  }

  // Recent-stimulus cooldown: if last reliable session was hard within 36h,
  // force aerobic / recovery on the FIRST training day.
  const hoursAgo = hoursSince(input.recentState);
  const recentHardCooldown =
    HARD_STIMULI.has(input.recentState.latestStimulus) &&
    hoursAgo !== null &&
    hoursAgo < 36;
  if (!input.forceRequestedSchedule && input.isFirstTraining && recentHardCooldown) {
    return forceAerobic(
      input.sport,
      allowedIds,
      '近 36 小时内有阈值/VO2 刺激，先做有氧。',
    );
  }

  // Tired + first day -> aerobic.
  if (
    !input.forceRequestedSchedule &&
    input.isFirstTraining &&
    input.recentState.fatigue === 'tired'
  ) {
    return forceAerobic(input.sport, allowedIds, '已有疲劳，开局做有氧。');
  }

  // Previous day was hard -> not hard today (avoid back-to-back).
  // We let hard-cap-reached logic skip high-intensity below.

  const hardCapReached = input.hardScheduled >= input.hardCap;

  // Long run / long ride preference: schedule 1/wk per available endurance
  // sport, but only when not adjacent to a hard day.
  if (
    input.sport === 'running' &&
    !input.longRunScheduled &&
    (!input.prevIntensityHigh || input.forceRequestedSchedule) &&
    allowedIds.has('run.lsd.v1') &&
    // Mid/late week is a better LSD slot than day 1.
    input.dayIndex >= 4 &&
    (!recentHardCooldown || input.forceRequestedSchedule)
  ) {
    return {
      templateId: 'run.lsd.v1',
      reason: '本周长距离有氧。',
      intensity: 'low',
    };
  }
  if (
    input.sport === 'cycling' &&
    !input.longRideScheduled &&
    (!input.prevIntensityHigh || input.forceRequestedSchedule) &&
    allowedIds.has('bike.long_ride.v1') &&
    input.dayIndex >= 4 &&
    (!recentHardCooldown || input.forceRequestedSchedule)
  ) {
    return {
      templateId: 'bike.long_ride.v1',
      reason: '本周长距离骑行。',
      intensity: 'low',
    };
  }

  // Goal-driven: race-pace or threshold once per week if a race is targeted.
  if (
    input.sport === 'running' &&
    input.wantsRacePace &&
    !input.racePaceScheduled &&
    !hardCapReached &&
    (!input.prevIntensityHigh || input.forceRequestedSchedule) &&
    allowedIds.has('run.race_pace.v1')
  ) {
    return {
      templateId: 'run.race_pace.v1',
      reason: '比赛目标专项配速课。',
      intensity: 'high',
    };
  }

  // Default rotation by day position (deterministic).
  // Try high-intensity first only if cap allows AND prev day not high.
  const rotation = pickRotationCandidates(input);
  for (const candidateId of rotation) {
    if (!allowedIds.has(candidateId)) continue;
    const intensity = templateIntensity(candidateId);
    if (
      intensity === 'high' &&
      (hardCapReached || (!input.forceRequestedSchedule && input.prevIntensityHigh))
    ) {
      continue;
    }
    return {
      templateId: candidateId,
      reason: rotationReason(candidateId, intensity),
      intensity,
    };
  }

  // Fallback: aerobic for the sport, otherwise recovery.
  return forceAerobic(input.sport, allowedIds, '默认有氧。');
}

// Rotation order tries a balanced mix; harder templates are surfaced on
// odd-indexed days and aerobic on the others.
function pickRotationCandidates(input: PickInput): string[] {
  const { sport, dayIndex } = input;
  const isHardSlot = dayIndex % 2 === 0; // Tue/Thu/Sat-ish
  const preferAdvanced = shouldPreferAdvancedTemplates(input);
  if (sport === 'running') {
    if (isHardSlot) {
      if (preferAdvanced) {
        return rotateByHardSessionCount(
          [
            'run.reverse_pyramid.v1',
            'run.threshold.v1',
            'run.vo2max.v1',
            'run.interval.v1',
            'run.hill.v1',
            'run.tempo.v1',
            'run.aerobic.v1',
            'run.recovery.v1',
          ],
          input.hardScheduled,
        );
      }
      return [
        'run.threshold.v1',
        'run.tempo.v1',
        'run.interval.v1',
        'run.vo2max.v1',
        'run.aerobic.v1',
        'run.recovery.v1',
      ];
    }
    return ['run.aerobic.v1', 'run.strides.v1', 'run.recovery.v1'];
  }
  if (sport === 'cycling') {
    if (isHardSlot) {
      if (preferAdvanced) {
        return rotateByHardSessionCount(
          [
            'bike.over_under.v1',
            'bike.vo2max.v1',
            'bike.anaerobic.v1',
            'bike.climb.v1',
            'bike.threshold.v1',
            'bike.sweet_spot.v1',
            'bike.tempo.v1',
            'bike.endurance.v1',
            'bike.recovery_spin.v1',
          ],
          input.hardScheduled,
        );
      }
      return [
        'bike.threshold.v1',
        'bike.sweet_spot.v1',
        'bike.tempo.v1',
        'bike.vo2max.v1',
        'bike.endurance.v1',
        'bike.recovery_spin.v1',
      ];
    }
    return ['bike.endurance.v1', 'bike.tempo.v1', 'bike.recovery_spin.v1'];
  }
  // swimming
  if (isHardSlot) {
    if (preferAdvanced) {
      return rotateByHardSessionCount(
        [
          'swim.vo2max.v1',
          'swim.sprint.v1',
          'swim.css_threshold.v1',
          'swim.aerobic.v1',
          'swim.endurance.v1',
          'swim.technique.v1',
          'swim.recovery.v1',
        ],
        input.hardScheduled,
      );
    }
    return [
      'swim.css_threshold.v1',
      'swim.aerobic.v1',
      'swim.endurance.v1',
      'swim.vo2max.v1',
      'swim.technique.v1',
      'swim.recovery.v1',
    ];
  }
  return ['swim.aerobic.v1', 'swim.technique.v1', 'swim.recovery.v1'];
}

function shouldPreferAdvancedTemplates(input: PickInput): boolean {
  if (input.request.allowAdvancedWorkouts !== true) return false;
  if (input.hardCap <= 0 || input.recentState.fatigue === 'high_risk') return false;
  const daily = estimateTrainingMinutesPerActiveDay(input.request) ?? 0;
  const hardCap = input.request.maxHardSessionsPerWeek ?? input.hardCap;
  return daily >= 75 || hardCap >= 3 || input.athleteProfile.experienceLevel === 'advanced';
}

function rotateByHardSessionCount(ids: string[], hardScheduled: number): string[] {
  const highIds = ids.filter((id) => templateIntensity(id) === 'high');
  const rest = ids.filter((id) => templateIntensity(id) !== 'high');
  if (highIds.length === 0) return ids;
  const offset = hardScheduled % highIds.length;
  return [...highIds.slice(offset), ...highIds.slice(0, offset), ...rest];
}

function rotationReason(templateId: string, intensity: 'low' | 'medium' | 'high'): string {
  if (intensity === 'high') return '本周质量课。';
  if (intensity === 'medium') return '本周中强度课。';
  return '常规有氧/恢复。';
}

function forceRecovery(
  sport: ActiveSport,
  allowedIds: Set<string>,
  reason: string,
): PickOutput {
  const order =
    sport === 'running'
      ? ['run.recovery.v1', 'run.aerobic.v1']
      : sport === 'cycling'
        ? ['bike.recovery_spin.v1', 'bike.endurance.v1']
        : ['swim.recovery.v1', 'swim.technique.v1'];
  for (const id of order) {
    if (allowedIds.has(id)) {
      return { templateId: id, reason, intensity: templateIntensity(id) };
    }
  }
  return activeRecoveryFallback(sport, reason);
}

function forceAerobic(
  sport: ActiveSport,
  allowedIds: Set<string>,
  reason: string,
): PickOutput {
  const order =
    sport === 'running'
      ? ['run.aerobic.v1', 'run.recovery.v1']
      : sport === 'cycling'
        ? ['bike.endurance.v1', 'bike.recovery_spin.v1']
        : ['swim.aerobic.v1', 'swim.technique.v1', 'swim.recovery.v1'];
  for (const id of order) {
    if (allowedIds.has(id)) {
      return { templateId: id, reason, intensity: templateIntensity(id) };
    }
  }
  return activeRecoveryFallback(sport, reason);
}

function activeRecoveryFallback(sport: ActiveSport, reason: string): PickOutput {
  const templateId =
    sport === 'running'
      ? 'run.recovery.v1'
      : sport === 'cycling'
        ? 'bike.recovery_spin.v1'
        : 'swim.recovery.v1';
  return {
    templateId,
    reason: `${reason} 已保留为低强度训练，避免训练日变成休息日。`,
    intensity: templateIntensity(templateId),
  };
}

function filterAthleteProfileForScheduling(
  profile: AthleteProfile,
  forceRequestedSchedule: boolean,
) {
  return {
    // Injuries come from the user and should still be respected in strict mode.
    injuries: profile.injuries,
    experienceLevel: profile.experienceLevel,
    running: {
      confidence: forceRequestedSchedule ? 'high' as const : profile.running.confidence,
    },
    cycling: {
      confidence: forceRequestedSchedule ? 'high' as const : profile.cycling.confidence,
      ftpWatts: profile.cycling.ftpWatts ?? null,
    },
    swimming: {
      confidence: forceRequestedSchedule ? 'high' as const : profile.swimming.confidence,
    },
  };
}

function filterRecentStateForScheduling(
  state: RecentState,
  forceRequestedSchedule: boolean,
) {
  if (forceRequestedSchedule) {
    return {
      latestStimulus: null,
      fatigue: 'normal' as const,
    };
  }
  return {
    latestStimulus:
      state.latestStimulus === 'unknown'
        ? null
        : state.latestStimulus,
    fatigue:
      state.fatigue === 'fresh'
        ? 'normal' as const
        : state.fatigue,
  };
}

// ---------------------------------------------------------------------------
// Rest-day construction
// ---------------------------------------------------------------------------

function buildRestEntry(
  dayIndex: number,
  weekStartDate: string,
  recentState: RecentState,
  trainingCapacity?: TrainingCapacity,
): ScheduleEntry {
  const restTemplate =
    recentState.fatigue === 'tired' || recentState.fatigue === 'high_risk'
      ? 'rest.full.v1'
      : 'rest.mobility.v1';
  const entry: ScheduleEntry = {
    dayIndex,
    date: addDays(weekStartDate, dayIndex - 1),
    dayLabel: DAY_LABELS[dayIndex - 1],
    sport: getTemplate(restTemplate)!.fixed.sport,
    templateId: restTemplate,
    reason:
      restTemplate === 'rest.full.v1'
        ? '完全休息日。'
        : '低强度活动恢复。',
  };
  applyDurationCap(entry, trainingCapacity);
  return entry;
}

function chooseTimeOfDay(
  request: ScheduleRequest,
  dayIndex: number,
): ScheduleEntry['timeOfDay'] | undefined {
  const windows = request.preferredTrainingWindows ?? [];
  if (windows.length === 0) return undefined;
  const raw = windows[(dayIndex - 1) % windows.length] ?? '';
  return parseTrainingWindow(raw);
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

function buildAllRestWeek(
  weekStartDate: string,
  recentState: RecentState,
  trainingCapacity?: TrainingCapacity,
): ScheduleEntry[] {
  return [1, 2, 3, 4, 5, 6, 7].map((d) =>
    buildRestEntry(d, weekStartDate, recentState, trainingCapacity),
  );
}

export function applyDurationCap(
  entry: ScheduleEntry,
  trainingCapacity?: TrainingCapacity,
): ScheduleEntry {
  const cap = getCapacityDurationCap(trainingCapacity, entry.sport, entry.templateId);
  if (!cap) return entry;
  entry.durationCapMinutes = cap.minutes;
  entry.durationCapReason = cap.reason;
  return entry;
}

// ---------------------------------------------------------------------------
// Sanity pass — never two high days in a row, never exceed cap.
// ---------------------------------------------------------------------------

function applySanityPass(
  days: Array<ScheduleEntry | null>,
  hardCap: number,
  notes: string[],
  forceRequestedSchedule: boolean,
): void {
  let hardCount = 0;
  let prevHigh = false;
  for (let i = 0; i < days.length; i += 1) {
    const entry = days[i];
    if (!entry) continue;
    const intensity = templateIntensity(entry.templateId);
    if (intensity === 'high') {
      if ((!forceRequestedSchedule && prevHigh) || hardCount >= hardCap) {
        // Swap to aerobic / recovery for the sport.
        const sport = entry.sport;
        const replacement = swapToAerobic(sport);
        if (replacement && replacement !== entry.templateId) {
          notes.push(
            `${entry.dayLabel} 由 ${entry.templateId} 调整为 ${replacement}（${
              hardCount >= hardCap ? '超出用户高强度上限' : '避免连续高强度'
            }）。`,
          );
          days[i] = {
            ...entry,
            templateId: replacement,
            reason: `${entry.reason ?? ''} 受连续高强度/上限保护，自动降级。`.trim(),
          };
          prevHigh = templateIntensity(replacement) === 'high';
          if (templateIntensity(replacement) === 'high') hardCount += 1;
        } else {
          // Keep as-is if no replacement; still update prevHigh.
          prevHigh = true;
          hardCount += 1;
        }
      } else {
        prevHigh = true;
        hardCount += 1;
      }
    } else {
      prevHigh = false;
    }
  }
}

function swapToAerobic(sport: Sport): string | null {
  if (sport === 'running') return 'run.aerobic.v1';
  if (sport === 'cycling') return 'bike.endurance.v1';
  if (sport === 'swimming') return 'swim.aerobic.v1';
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function templateIntensity(templateId: string): 'low' | 'medium' | 'high' {
  const tpl = getTemplate(templateId);
  return tpl ? tpl.fixed.intensity : 'low';
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function normalizeDaysPerWeek(value: number): number {
  return clamp(Math.round(value), 1, 7);
}

export function estimateTrainingMinutesPerActiveDay(
  request: Pick<ScheduleRequest, 'dailyPreferredMinutes' | 'weeklyMaxMinutes' | 'daysPerWeek'>,
): number | null {
  if (
    request.dailyPreferredMinutes !== null &&
    request.dailyPreferredMinutes !== undefined &&
    Number.isFinite(request.dailyPreferredMinutes)
  ) {
    return request.dailyPreferredMinutes;
  }
  if (
    request.weeklyMaxMinutes !== null &&
    request.weeklyMaxMinutes !== undefined &&
    Number.isFinite(request.weeklyMaxMinutes)
  ) {
    return request.weeklyMaxMinutes / normalizeDaysPerWeek(request.daysPerWeek);
  }
  return null;
}

export function formatDayIndexes(days: Iterable<number>): string {
  return Array.from(days)
    .filter((d) => d >= 1 && d <= 7)
    .sort((a, b) => a - b)
    .map((d) => DAY_LABELS[d - 1])
    .join('、');
}

function firstDayIndexInText(raw: string): number | null {
  for (const spec of DAY_REFERENCE_PATTERNS) {
    spec.pattern.lastIndex = 0;
    if (spec.pattern.test(raw)) return spec.dayIndex;
  }
  return null;
}

function hasTrainingIntent(textWindow: string): boolean {
  if (NEGATED_REST_INTENT_RE.test(textWindow)) return true;
  if (REST_INTENT_RE.test(textWindow)) {
    return false;
  }
  return TRAINING_DAY_INTENT_RE.test(textWindow);
}

function addDays(yyyymmdd: string, offset: number): string {
  // Treat the input as a UTC midnight date so timezone math doesn't drift.
  const [y, m, d] = yyyymmdd.split('-').map((p) => Number(p));
  if (!y || !m || !d) return yyyymmdd;
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + offset);
  const yy = base.getUTCFullYear();
  const mm = String(base.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(base.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function hoursSince(state: RecentState): number | null {
  const ts = state.latestReliableActivity?.startTimeLocal?.getTime();
  if (!ts) return null;
  const ms = Date.now() - ts;
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms / (60 * 60 * 1000);
}

function shouldIncludeRacePace(request: ScheduleRequest): boolean {
  if (!request.raceDate) return false;
  if (!request.goalDistance) return false;
  if (!request.sports.running) return false;
  const target = parseDate(request.raceDate);
  if (!target) return false;
  const diffMs = target.getTime() - Date.now();
  if (diffMs <= 0) return false;
  const weeks = diffMs / (7 * 24 * 60 * 60 * 1000);
  return weeks <= 12;
}

function parseDate(s: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
}

// Re-export Sport / WorkoutTemplate for caller convenience.
export type { Sport, WorkoutTemplate };
