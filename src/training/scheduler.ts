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
  expectedLoad?: number | null;
  allowAdvancedWorkouts?: boolean;
  allowDoubleDays?: boolean;
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

const HARD_STIMULI: ReadonlySet<string> = new Set(['threshold', 'vo2max', 'anaerobic']);

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
}

export function buildWeeklySchedule(args: BuildScheduleArgs): ScheduleResult {
  const { request, athleteProfile, recentState } = args;

  const enabledSports = getEnabledSports(request);
  const notes: string[] = [];

  if (enabledSports.length === 0) {
    // Nothing enabled — fall back to a fully-rest week.
    notes.push('未选择任何运动，本周安排完全休息。');
    return {
      days: buildAllRestWeek(request.weekStartDate, recentState),
      notes,
    };
  }

  const daysPerWeek = clamp(Math.round(request.daysPerWeek), 1, 7);
  const restDays = decideRestDays(daysPerWeek, request.preferredRestDay);

  const trainingDayIndexes = [1, 2, 3, 4, 5, 6, 7].filter(
    (d) => !restDays.includes(d),
  );

  const sportOrder = decideSportOrder(request, enabledSports);
  const dayToSport = assignSports(trainingDayIndexes, sportOrder);

  // Effective hard-session cap.
  const baseCap =
    request.maxHardSessionsPerWeek ?? DEFAULT_MAX_HARD_SESSIONS_PER_WEEK;
  let hardCap = Math.min(baseCap, 2);
  if (
    athleteProfile.experienceLevel === 'advanced' &&
    (recentState.fatigue === 'fresh' || recentState.fatigue === 'normal')
  ) {
    hardCap = Math.min(baseCap, 3);
  }
  notes.push(`本周高强度课上限 ${hardCap} 次。`);

  if (HARD_STIMULI.has(recentState.latestStimulus)) {
    const hoursAgo = hoursSince(recentState);
    if (hoursAgo !== null && hoursAgo < 36) {
      notes.push(
        `近 36 小时内有 ${recentState.latestStimulus} 刺激，本周开局优先恢复。`,
      );
    }
  }
  if (recentState.fatigue === 'high_risk') {
    notes.push('近期负荷偏高，本周以恢复和低强度有氧为主。');
  } else if (recentState.fatigue === 'tired') {
    notes.push('已有疲劳，本周第一次训练以轻松课开局。');
  }
  if (request.dailyPreferredMinutes && request.dailyPreferredMinutes > 0) {
    notes.push(`单次训练尽量靠近 ${request.dailyPreferredMinutes} 分钟。`);
  }
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
    });

    days[dayIndex - 1] = {
      dayIndex,
      date: addDays(request.weekStartDate, dayIndex - 1),
      dayLabel: DAY_LABELS[dayIndex - 1],
      sport,
      templateId: pick.templateId,
      slotIndex: 1,
      timeOfDay: chooseTimeOfDay(request, dayIndex),
      reason: pick.reason,
    };

    if (pick.intensity === 'high') hardScheduled += 1;
    if (pick.templateId === 'run.lsd.v1') longRunScheduled = true;
    if (pick.templateId === 'bike.long_ride.v1') longRideScheduled = true;
    if (pick.templateId === 'run.race_pace.v1') racePaceScheduled = true;
  }

  // Fill rest days.
  for (const dayIndex of restDays) {
    days[dayIndex - 1] = buildRestEntry(dayIndex, request.weekStartDate, recentState);
  }

  // Sanity pass: drop consecutive-hard violations and over-cap.
  applySanityPass(days, hardCap, notes);

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
): number[] {
  const defaults = DEFAULT_REST_DAYS_BY_DPW[daysPerWeek] ?? [];

  const preferred = preferredRestDayName
    ? DAY_NAME_TO_INDEX[preferredRestDayName.toLowerCase()] ?? null
    : null;

  if (preferred && !defaults.includes(preferred)) {
    // Replace one of the default rest days with the preferred one if needed.
    if (defaults.length === 0) {
      // 7-day plan — no rest day by default; ignore preferred.
      return [];
    }
    const replacement = [...defaults];
    replacement[0] = preferred;
    return Array.from(new Set(replacement)).sort((a, b) => a - b);
  }

  return defaults.slice().sort((a, b) => a - b);
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
}

interface PickOutput {
  templateId: string;
  reason: string;
  intensity: 'low' | 'medium' | 'high';
}

function pickTemplateForDay(input: PickInput): PickOutput {
  const allowed = filterAllowedTemplates({
    sport: input.sport,
    athleteProfile: {
      injuries: input.athleteProfile.injuries,
      experienceLevel: input.athleteProfile.experienceLevel,
      running: { confidence: input.athleteProfile.running.confidence },
      cycling: {
        confidence: input.athleteProfile.cycling.confidence,
        ftpWatts: input.athleteProfile.cycling.ftpWatts ?? null,
      },
      swimming: { confidence: input.athleteProfile.swimming.confidence },
    },
    recentState: {
      latestStimulus:
        input.recentState.latestStimulus === 'unknown'
          ? null
          : input.recentState.latestStimulus,
      fatigue:
        input.recentState.fatigue === 'fresh'
          ? 'normal'
          : input.recentState.fatigue,
    },
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
  if (input.recentState.fatigue === 'high_risk' && input.dayIndex <= 2) {
    return forceRecovery(input.sport, allowedIds, '近期高风险疲劳，先做恢复。');
  }

  // Recent-stimulus cooldown: if last reliable session was hard within 36h,
  // force aerobic / recovery on the FIRST training day.
  const hoursAgo = hoursSince(input.recentState);
  const recentHardCooldown =
    HARD_STIMULI.has(input.recentState.latestStimulus) &&
    hoursAgo !== null &&
    hoursAgo < 36;
  if (input.isFirstTraining && recentHardCooldown) {
    return forceAerobic(
      input.sport,
      allowedIds,
      '近 36 小时内有阈值/VO2 刺激，先做有氧。',
    );
  }

  // Tired + first day -> aerobic.
  if (input.isFirstTraining && input.recentState.fatigue === 'tired') {
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
    !input.prevIntensityHigh &&
    allowedIds.has('run.lsd.v1') &&
    // Mid/late week is a better LSD slot than day 1.
    input.dayIndex >= 4 &&
    !recentHardCooldown
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
    !input.prevIntensityHigh &&
    allowedIds.has('bike.long_ride.v1') &&
    input.dayIndex >= 4 &&
    !recentHardCooldown
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
    !input.prevIntensityHigh &&
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
  const rotation = pickRotationCandidates(input.sport, input.dayIndex);
  for (const candidateId of rotation) {
    if (!allowedIds.has(candidateId)) continue;
    const intensity = templateIntensity(candidateId);
    if (intensity === 'high' && (hardCapReached || input.prevIntensityHigh)) {
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
function pickRotationCandidates(sport: ActiveSport, dayIndex: number): string[] {
  const isHardSlot = dayIndex % 2 === 0; // Tue/Thu/Sat-ish
  if (sport === 'running') {
    if (isHardSlot) {
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
  // No recovery template allowed for this sport — fall back to rest.
  return { templateId: 'rest.full.v1', reason, intensity: 'low' };
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
  return { templateId: 'rest.full.v1', reason, intensity: 'low' };
}

// ---------------------------------------------------------------------------
// Rest-day construction
// ---------------------------------------------------------------------------

function buildRestEntry(
  dayIndex: number,
  weekStartDate: string,
  recentState: RecentState,
): ScheduleEntry {
  const restTemplate =
    recentState.fatigue === 'tired' || recentState.fatigue === 'high_risk'
      ? 'rest.full.v1'
      : 'rest.mobility.v1';
  return {
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
): ScheduleEntry[] {
  return [1, 2, 3, 4, 5, 6, 7].map((d) =>
    buildRestEntry(d, weekStartDate, recentState),
  );
}

// ---------------------------------------------------------------------------
// Sanity pass — never two high days in a row, never exceed cap.
// ---------------------------------------------------------------------------

function applySanityPass(
  days: Array<ScheduleEntry | null>,
  hardCap: number,
  notes: string[],
): void {
  let hardCount = 0;
  let prevHigh = false;
  for (let i = 0; i < days.length; i += 1) {
    const entry = days[i];
    if (!entry) continue;
    const intensity = templateIntensity(entry.templateId);
    if (intensity === 'high') {
      if (prevHigh || hardCount >= hardCap) {
        // Swap to aerobic / recovery for the sport.
        const sport = entry.sport;
        const replacement = swapToAerobic(sport);
        if (replacement && replacement !== entry.templateId) {
          notes.push(
            `${entry.dayLabel} 由 ${entry.templateId} 调整为 ${replacement}（避免连续高强度或超出本周上限）。`,
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
