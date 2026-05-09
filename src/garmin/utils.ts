export interface RawActivity {
  activityId: string | number;
  activityName?: string;
  activityType?: { typeKey?: string };
  startTimeLocal?: string;
  distance?: number;
  duration?: number;
  averageSpeed?: number;
  averageHR?: number;
  // Enriched fields below are not declared here because Garmin returns them
  // at varying paths depending on activity source / API version. We resolve
  // them via ACTIVITY_FIELD_ALIASES + pickFirst, treating the activity as
  // unknown for the purpose of those lookups.
}

export interface MappedActivity {
  id: string;
  region: 'cn' | 'global';
  activityId: string | number;
  signature: string;
  name: string;
  type: string;
  startTimeLocal: string | null;
  distanceKm: number;
  durationMin: number;
  averageHr: number | null;
  averagePaceMinPerKm: number | null;
  averagePaceText: string | null;
  // Enriched training metrics (Unit 2). All optional — Garmin doesn't always
  // populate these and the source path varies by activity type.
  trainingLoad?: number;
  trainingEffectLabel?: string;
  aerobicTrainingEffect?: number;
  anaerobicTrainingEffect?: number;
  primaryBenefit?: string;
  benefitType?: string;
  trainingEffectMessage?: string;
  averageSpeed?: number;
  maxSpeed?: number;
  elevationGain?: number;
  averagePower?: number;
  normalizedPower?: number;
  averageCadence?: number;
  deviceName?: string;
  source?: string;
  rawTrainingSummary?: unknown;
}

/**
 * Resolve the first non-empty value at any of the given dot-paths within
 * `source`. Returns `undefined` when no path yields a value.
 *
 * Garmin returns the same logical field at different paths depending on
 * activity origin and API version, so callers pass an ordered list of
 * aliases to try.
 */
export function pickFirst<T = unknown>(
  source: unknown,
  paths: readonly string[],
): T | undefined {
  for (const path of paths) {
    const value = path
      .split('.')
      .reduce<unknown>((acc, key) => {
        if (acc == null || typeof acc !== 'object') return undefined;
        return (acc as Record<string, unknown>)[key];
      }, source);
    if (value !== undefined && value !== null && value !== '') {
      return value as T;
    }
  }
  return undefined;
}

/**
 * Single source of truth for which raw-Garmin paths feed each enriched
 * field on MappedActivity. Both mapActivity() and the dump-payload script
 * read from this constant so they stay in lockstep.
 *
 * The `source` field is hardcoded ('garmin') in mapActivity and the
 * `rawTrainingSummary` field is `activity.summaryDTO` verbatim — neither
 * goes through pickFirst, so they are absent from this map.
 */
export const ACTIVITY_FIELD_ALIASES = {
  trainingLoad: [
    'trainingLoad',
    'activityTrainingLoad',
    'summaryDTO.trainingLoad',
    'activitySummary.trainingLoad',
  ],
  trainingEffectLabel: [
    'trainingEffectLabel',
    'summaryDTO.trainingEffectLabel',
    'trainingEffect.label',
  ],
  aerobicTrainingEffect: [
    'aerobicTrainingEffect',
    'summaryDTO.aerobicTrainingEffect',
  ],
  anaerobicTrainingEffect: [
    'anaerobicTrainingEffect',
    'summaryDTO.anaerobicTrainingEffect',
  ],
  primaryBenefit: [
    'primaryBenefit',
    'summaryDTO.primaryBenefit',
    'activitySummary.primaryBenefit',
  ],
  benefitType: ['benefitType', 'summaryDTO.benefitType'],
  trainingEffectMessage: [
    'trainingEffectMessage',
    'summaryDTO.trainingEffectMessage',
  ],
  averageSpeed: ['averageSpeed', 'summaryDTO.averageSpeed'],
  maxSpeed: ['maxSpeed', 'summaryDTO.maxSpeed'],
  elevationGain: [
    'elevationGain',
    'summaryDTO.elevationGain',
    'totalAscent',
  ],
  averagePower: ['averagePower', 'avgPower', 'summaryDTO.averagePower'],
  normalizedPower: ['normalizedPower', 'summaryDTO.normalizedPower'],
  averageCadence: [
    'averageCadence',
    'avgCadence',
    'summaryDTO.averageCadence',
  ],
  deviceName: ['deviceName', 'device.name', 'summaryDTO.deviceName'],
} as const satisfies Record<string, readonly string[]>;

export type ActivityAliasKey = keyof typeof ACTIVITY_FIELD_ALIASES;

/** Coerce a candidate value into a finite number or undefined. */
function toFiniteNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Coerce a candidate value into a non-empty string or undefined. */
function toNonEmptyString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = typeof value === 'string' ? value : String(value);
  return s.length > 0 ? s : undefined;
}

export function activitySignature(activity: RawActivity): string {
  return [
    activity.startTimeLocal || '',
    activity.activityType?.typeKey || 'unknown',
    Math.round(activity.distance || 0),
    Math.round(activity.duration || 0),
  ].join('|');
}

export function paceFromSpeed(averageSpeed: number | undefined) {
  if (!averageSpeed || averageSpeed <= 0) {
    return { value: null, text: null };
  }
  const minutesPerKm = 1000 / averageSpeed / 60;
  const minutes = Math.floor(minutesPerKm);
  const seconds = Math.round((minutesPerKm - minutes) * 60);
  return {
    value: Number(minutesPerKm.toFixed(2)),
    text: `${minutes}:${String(seconds).padStart(2, '0')}`,
  };
}

export function mapActivity(
  activity: RawActivity,
  region: 'cn' | 'global',
): MappedActivity {
  const pace = paceFromSpeed(activity.averageSpeed);
  // Treat the activity as unknown when reading enriched fields — Garmin's
  // shape varies across endpoints and the RawActivity interface only locks
  // down the fields we already relied on.
  const raw: unknown = activity;

  const summaryDTO =
    typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>).summaryDTO
      : undefined;

  return {
    id: `${region}-${activity.activityId}`,
    region,
    activityId: activity.activityId,
    signature: activitySignature(activity),
    name: activity.activityName || '未命名活动',
    type: activity.activityType?.typeKey || 'unknown',
    startTimeLocal: activity.startTimeLocal || null,
    distanceKm: Number(((activity.distance || 0) / 1000).toFixed(2)),
    durationMin: Number(((activity.duration || 0) / 60).toFixed(1)),
    averageHr: activity.averageHR || null,
    averagePaceMinPerKm: pace.value,
    averagePaceText: pace.text,
    // Enriched fields. Each runs through pickFirst with the alias list,
    // then a type-appropriate coercion. Numerics that don't parse to a
    // finite number are dropped; strings that are empty are dropped.
    trainingLoad: toFiniteNumber(pickFirst(raw, ACTIVITY_FIELD_ALIASES.trainingLoad)),
    trainingEffectLabel: toNonEmptyString(
      pickFirst(raw, ACTIVITY_FIELD_ALIASES.trainingEffectLabel),
    ),
    aerobicTrainingEffect: toFiniteNumber(
      pickFirst(raw, ACTIVITY_FIELD_ALIASES.aerobicTrainingEffect),
    ),
    anaerobicTrainingEffect: toFiniteNumber(
      pickFirst(raw, ACTIVITY_FIELD_ALIASES.anaerobicTrainingEffect),
    ),
    primaryBenefit: toNonEmptyString(
      pickFirst(raw, ACTIVITY_FIELD_ALIASES.primaryBenefit),
    ),
    benefitType: toNonEmptyString(
      pickFirst(raw, ACTIVITY_FIELD_ALIASES.benefitType),
    ),
    trainingEffectMessage: toNonEmptyString(
      pickFirst(raw, ACTIVITY_FIELD_ALIASES.trainingEffectMessage),
    ),
    averageSpeed: toFiniteNumber(pickFirst(raw, ACTIVITY_FIELD_ALIASES.averageSpeed)),
    maxSpeed: toFiniteNumber(pickFirst(raw, ACTIVITY_FIELD_ALIASES.maxSpeed)),
    elevationGain: toFiniteNumber(
      pickFirst(raw, ACTIVITY_FIELD_ALIASES.elevationGain),
    ),
    averagePower: toFiniteNumber(
      pickFirst(raw, ACTIVITY_FIELD_ALIASES.averagePower),
    ),
    normalizedPower: toFiniteNumber(
      pickFirst(raw, ACTIVITY_FIELD_ALIASES.normalizedPower),
    ),
    averageCadence: toFiniteNumber(
      pickFirst(raw, ACTIVITY_FIELD_ALIASES.averageCadence),
    ),
    deviceName: toNonEmptyString(pickFirst(raw, ACTIVITY_FIELD_ALIASES.deviceName)),
    source: 'garmin',
    rawTrainingSummary: summaryDTO,
  };
}

export function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function getRegionLabel(region: 'cn' | 'global') {
  return region === 'cn' ? '国区' : '国际区';
}

export function getErrorStatus(error: unknown): number {
  const e = error as { response?: { status?: number }; status?: number; statusCode?: number };
  return Number(e?.response?.status || e?.status || e?.statusCode || 0);
}

export function isDuplicateUploadConflict(error: unknown): boolean {
  const status = getErrorStatus(error);
  const message = String((error as Error)?.message || '');
  return status === 409 || message.includes('HTTP Error (409): Conflict');
}

export function isRetryableTransferError(error: unknown): boolean {
  const status = getErrorStatus(error);
  const message = String((error as Error)?.message || '');
  if (!message && !status) return false;
  if (
    message.includes('Request Timeout') ||
    message.includes('ECONNABORTED') ||
    message.includes('Network error')
  ) {
    return true;
  }
  return [408, 425, 429, 500, 502, 503, 504, 520, 522, 524].includes(status);
}

export function humanizeSyncFailure(
  error: unknown,
  targetRegion?: 'cn' | 'global',
): string {
  const message = String((error as Error)?.message || '');
  if (message.includes('HTTP Error (412): Precondition Failed')) {
    const label = targetRegion ? getRegionLabel(targetRegion) : '目标区';
    return `${label}账号拒绝活动导入。这个账号还没有授予上传 consent，请先登录 ${label} Garmin Connect 网页手动完成一次活动导入授权后再重试。`;
  }
  if (isRetryableTransferError(error)) {
    return 'Garmin 服务器响应超时或临时异常。下次同步会自动重试已经失败的活动。';
  }
  return message || '同步失败';
}

export function humanizeAuthError(
  region: 'cn' | 'global',
  error: unknown,
): string {
  const message = String((error as Error)?.message || '');
  const regionLabel = getRegionLabel(region);
  if (message.includes('HTTP Error (429)') || message.includes('Too Many Requests')) {
    return `${regionLabel}Garmin 服务器对当前请求节流（429）。请稍后再试，如果反复出现请告诉作者，可能需要换出口 IP。`;
  }
  if (message.includes('DI token exchange failed')) {
    return `${regionLabel}DI 令牌兑换失败。常见原因：service ticket 已被使用过、过期（CAS ticket 通常 5 分钟内有效），或 client_id 全部失效。请重新点"连接 Garmin"获取新 ticket。`;
  }
  if (message.includes('No OAuth2 token available')) {
    return `${regionLabel}登录失败：无法获取 OAuth 令牌，请检查账号密码或稍后重试`;
  }
  if (message.includes('Cannot find module')) {
    return `${regionLabel}登录依赖缺失：${message}`;
  }
  return message || `${regionLabel}登录失败`;
}
