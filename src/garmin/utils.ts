export interface RawActivity {
  activityId: string | number;
  activityName?: string;
  activityType?: { typeKey?: string };
  startTimeLocal?: string;
  distance?: number;
  duration?: number;
  averageSpeed?: number;
  averageHR?: number;
  maxHR?: number;
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
  maxHr: number | null;
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
  maxPower?: number;
  maxPowerTwentyMinutes?: number;
  functionalThresholdPower?: number;
  averageCadence?: number;
  maxCadence?: number;
  groundContactTime?: number;
  verticalOscillation?: number;
  verticalRatio?: number;
  strideLength?: number;
  vo2Max?: number;
  lactateThresholdHr?: number;
  lactateThresholdPaceMinPerKm?: number;
  trainingStatus?: string;
  hrvStatus?: string;
  sleepDurationHours?: number;
  sleepScore?: number;
  recoveryTimeHours?: number;
  heartRateZones?: Array<[number, number]>;
  hrTimeInZone_1?: number;
  hrTimeInZone_2?: number;
  hrTimeInZone_3?: number;
  hrTimeInZone_4?: number;
  hrTimeInZone_5?: number;
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
  averageHr: ['averageHR', 'averageHr', 'summaryDTO.averageHR', 'summaryDTO.averageHr'],
  averageSpeed: ['averageSpeed', 'summaryDTO.averageSpeed', 'detail.summaryDTO.averageSpeed'],
  maxHr: ['maxHR', 'maxHr', 'summaryDTO.maxHR', 'summaryDTO.maxHr'],
  maxSpeed: ['maxSpeed', 'summaryDTO.maxSpeed'],
  elevationGain: [
    'elevationGain',
    'summaryDTO.elevationGain',
    'totalAscent',
  ],
  averagePower: ['averagePower', 'avgPower', 'summaryDTO.averagePower'],
  normalizedPower: ['normalizedPower', 'summaryDTO.normalizedPower'],
  maxPower: ['maxPower', 'summaryDTO.maxPower'],
  maxPowerTwentyMinutes: [
    'maxPowerTwentyMinutes',
    'maxPower20Minutes',
    'maxPower20Min',
    'summaryDTO.maxPowerTwentyMinutes',
    'summaryDTO.maxPower20Minutes',
    'summaryDTO.maxPower20Min',
  ],
  functionalThresholdPower: [
    'functionalThresholdPower',
    'ftp',
    'summaryDTO.functionalThresholdPower',
    'summaryDTO.ftp',
  ],
  averageCadence: [
    'averageCadence',
    'avgCadence',
    'summaryDTO.averageCadence',
  ],
  maxCadence: ['maxCadence', 'summaryDTO.maxCadence'],
  groundContactTime: [
    'groundContactTime',
    'avgGroundContactTime',
    'averageGroundContactTime',
    'summaryDTO.groundContactTime',
    'summaryDTO.avgGroundContactTime',
    'summaryDTO.averageGroundContactTime',
  ],
  verticalOscillation: [
    'verticalOscillation',
    'avgVerticalOscillation',
    'averageVerticalOscillation',
    'summaryDTO.verticalOscillation',
    'summaryDTO.avgVerticalOscillation',
    'summaryDTO.averageVerticalOscillation',
  ],
  verticalRatio: [
    'verticalRatio',
    'avgVerticalRatio',
    'averageVerticalRatio',
    'summaryDTO.verticalRatio',
    'summaryDTO.avgVerticalRatio',
    'summaryDTO.averageVerticalRatio',
  ],
  strideLength: [
    'strideLength',
    'avgStrideLength',
    'averageStrideLength',
    'summaryDTO.strideLength',
    'summaryDTO.avgStrideLength',
    'summaryDTO.averageStrideLength',
  ],
  vo2Max: [
    'vo2Max',
    'vO2MaxValue',
    'summaryDTO.vo2Max',
    'summaryDTO.vO2MaxValue',
  ],
  lactateThresholdHr: [
    'lactateThresholdHr',
    'lactateThresholdHeartRate',
    'summaryDTO.lactateThresholdHr',
    'summaryDTO.lactateThresholdHeartRate',
  ],
  lactateThresholdPace: [
    'lactateThresholdPace',
    'lactateThresholdPaceMinPerKm',
    'summaryDTO.lactateThresholdPace',
    'summaryDTO.lactateThresholdPaceMinPerKm',
  ],
  lactateThresholdSpeed: [
    'lactateThresholdSpeed',
    'summaryDTO.lactateThresholdSpeed',
  ],
  trainingStatus: [
    'trainingStatus',
    'summaryDTO.trainingStatus',
  ],
  hrvStatus: [
    'hrvStatus',
    'summaryDTO.hrvStatus',
  ],
  sleepDurationHours: [
    'sleepDurationHours',
    'sleepTimeSeconds',
    'summaryDTO.sleepDurationHours',
    'summaryDTO.sleepTimeSeconds',
  ],
  sleepScore: ['sleepScore', 'summaryDTO.sleepScore'],
  recoveryTimeHours: [
    'recoveryTimeHours',
    'recoveryTime',
    'summaryDTO.recoveryTimeHours',
    'summaryDTO.recoveryTime',
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

function normalizeHours(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  // Garmin sometimes reports seconds for sleep/recovery durations. Anything
  // larger than a week is almost certainly seconds.
  return value > 168 ? Number((value / 3600).toFixed(1)) : value;
}

function collectObjects(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  const obj = value as Record<string, unknown>;
  out.push(obj);
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') collectObjects(v, out);
  }
  return out;
}

function readZoneNumber(obj: Record<string, unknown>): number | null {
  const n =
    toFiniteNumber(obj.zoneNumber) ??
    toFiniteNumber(obj.zone) ??
    toFiniteNumber(obj.zoneIndex) ??
    toFiniteNumber(obj.hrZone);
  return n !== undefined && n >= 1 && n <= 7 ? Math.round(n) : null;
}

function readZoneBoundary(
  obj: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const n = toFiniteNumber(obj[key]);
    if (n !== undefined && n >= 30 && n <= 240) return Math.round(n);
  }
  return null;
}

function extractHeartRateZones(raw: unknown): Array<[number, number]> | undefined {
  const byZone = new Map<number, [number, number]>();
  for (const obj of collectObjects(raw)) {
    const zone = readZoneNumber(obj);
    if (zone === null) continue;
    const low = readZoneBoundary(obj, [
      'lowBoundary',
      'zoneLowBoundary',
      'lowerBound',
      'minHeartRate',
      'minHr',
      'startHeartRate',
      'startValue',
      'floor',
    ]);
    const high = readZoneBoundary(obj, [
      'highBoundary',
      'zoneHighBoundary',
      'upperBound',
      'maxHeartRate',
      'maxHr',
      'endHeartRate',
      'endValue',
      'ceiling',
    ]);
    if (low !== null && high !== null && high > low) {
      byZone.set(zone, [low, high]);
    }
  }
  if (byZone.size === 0) return undefined;
  return Array.from(byZone.entries())
    .sort(([a], [b]) => a - b)
    .map(([, range]) => range);
}

function lactateThresholdPaceMinPerKm(raw: unknown): number | undefined {
  const pace = toFiniteNumber(pickFirst(raw, ACTIVITY_FIELD_ALIASES.lactateThresholdPace));
  if (pace !== undefined && pace > 0) {
    // Pace may arrive as min/km or seconds/km depending on endpoint.
    return pace > 60 ? Number((pace / 60).toFixed(2)) : pace;
  }
  const speed = toFiniteNumber(pickFirst(raw, ACTIVITY_FIELD_ALIASES.lactateThresholdSpeed));
  return paceFromSpeed(speed).value ?? undefined;
}

export function activitySignature(activity: RawActivity): string {
  const raw = activity as unknown as Record<string, unknown>;
  const activityTypeDTO = raw.activityTypeDTO as { typeKey?: string } | undefined;
  return [
    activity.startTimeLocal || '',
    activity.activityType?.typeKey || activityTypeDTO?.typeKey || 'unknown',
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
  // Treat the activity as unknown when reading enriched fields — Garmin's
  // shape varies across endpoints and the RawActivity interface only locks
  // down the fields we already relied on.
  const raw: unknown = activity;
  const averageSpeed =
    toFiniteNumber(pickFirst(raw, ACTIVITY_FIELD_ALIASES.averageSpeed)) ??
    activity.averageSpeed;
  const pace = paceFromSpeed(averageSpeed);

  const summaryDTO =
    typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>).summaryDTO
      : undefined;
  const rawObj = typeof raw === 'object' && raw !== null
    ? (raw as Record<string, unknown>)
    : {};
  const activityTypeDTO = rawObj.activityTypeDTO as { typeKey?: string } | undefined;

  return {
    id: `${region}-${activity.activityId}`,
    region,
    activityId: activity.activityId,
    signature: activitySignature(activity),
    name: activity.activityName || 'Untitled activity',
    type: activity.activityType?.typeKey || activityTypeDTO?.typeKey || 'unknown',
    startTimeLocal: activity.startTimeLocal || null,
    distanceKm: Number(((activity.distance || 0) / 1000).toFixed(2)),
    durationMin: Number(((activity.duration || 0) / 60).toFixed(1)),
    averageHr:
      activity.averageHR ??
      toFiniteNumber(pickFirst(raw, ACTIVITY_FIELD_ALIASES.averageHr)) ??
      null,
    maxHr: activity.maxHR ?? toFiniteNumber(pickFirst(raw, ACTIVITY_FIELD_ALIASES.maxHr)) ?? null,
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
    averageSpeed,
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
    maxPower: toFiniteNumber(pickFirst(raw, ACTIVITY_FIELD_ALIASES.maxPower)),
    maxPowerTwentyMinutes: toFiniteNumber(
      pickFirst(raw, ACTIVITY_FIELD_ALIASES.maxPowerTwentyMinutes),
    ),
    functionalThresholdPower: toFiniteNumber(
      pickFirst(raw, ACTIVITY_FIELD_ALIASES.functionalThresholdPower),
    ),
    averageCadence: toFiniteNumber(
      pickFirst(raw, ACTIVITY_FIELD_ALIASES.averageCadence),
    ),
    maxCadence: toFiniteNumber(pickFirst(raw, ACTIVITY_FIELD_ALIASES.maxCadence)),
    groundContactTime: toFiniteNumber(
      pickFirst(raw, ACTIVITY_FIELD_ALIASES.groundContactTime),
    ),
    verticalOscillation: toFiniteNumber(
      pickFirst(raw, ACTIVITY_FIELD_ALIASES.verticalOscillation),
    ),
    verticalRatio: toFiniteNumber(
      pickFirst(raw, ACTIVITY_FIELD_ALIASES.verticalRatio),
    ),
    strideLength: toFiniteNumber(
      pickFirst(raw, ACTIVITY_FIELD_ALIASES.strideLength),
    ),
    vo2Max: toFiniteNumber(pickFirst(raw, ACTIVITY_FIELD_ALIASES.vo2Max)),
    lactateThresholdHr: toFiniteNumber(
      pickFirst(raw, ACTIVITY_FIELD_ALIASES.lactateThresholdHr),
    ),
    lactateThresholdPaceMinPerKm: lactateThresholdPaceMinPerKm(raw),
    trainingStatus: toNonEmptyString(
      pickFirst(raw, ACTIVITY_FIELD_ALIASES.trainingStatus),
    ),
    hrvStatus: toNonEmptyString(pickFirst(raw, ACTIVITY_FIELD_ALIASES.hrvStatus)),
    sleepDurationHours: normalizeHours(
      toFiniteNumber(pickFirst(raw, ACTIVITY_FIELD_ALIASES.sleepDurationHours)),
    ),
    sleepScore: toFiniteNumber(pickFirst(raw, ACTIVITY_FIELD_ALIASES.sleepScore)),
    recoveryTimeHours: normalizeHours(
      toFiniteNumber(pickFirst(raw, ACTIVITY_FIELD_ALIASES.recoveryTimeHours)),
    ),
    heartRateZones: extractHeartRateZones(raw),
    hrTimeInZone_1: toFiniteNumber((activity as unknown as Record<string, unknown>).hrTimeInZone_1),
    hrTimeInZone_2: toFiniteNumber((activity as unknown as Record<string, unknown>).hrTimeInZone_2),
    hrTimeInZone_3: toFiniteNumber((activity as unknown as Record<string, unknown>).hrTimeInZone_3),
    hrTimeInZone_4: toFiniteNumber((activity as unknown as Record<string, unknown>).hrTimeInZone_4),
    hrTimeInZone_5: toFiniteNumber((activity as unknown as Record<string, unknown>).hrTimeInZone_5),
    deviceName: toNonEmptyString(pickFirst(raw, ACTIVITY_FIELD_ALIASES.deviceName)),
    source: 'garmin',
    rawTrainingSummary: summaryDTO,
  };
}

export function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function getRegionLabel(region: 'cn' | 'global') {
  return region === 'cn' ? 'China region' : 'Global region';
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
    const label = targetRegion ? getRegionLabel(targetRegion) : 'Target region';
    return `${label}: the account rejected the activity import because it has not granted upload consent yet. Sign in to the ${label} Garmin Connect website, complete one manual activity import to grant consent, then retry.`;
  }
  if (isRetryableTransferError(error)) {
    return 'Garmin servers timed out or returned a temporary error. Failed activities will be retried automatically on the next sync.';
  }
  return message || 'Sync failed';
}

export function humanizeAuthError(
  region: 'cn' | 'global',
  error: unknown,
): string {
  const message = String((error as Error)?.message || '');
  const regionLabel = getRegionLabel(region);
  if (message.includes('HTTP Error (429)') || message.includes('Too Many Requests')) {
    return `${regionLabel}: Garmin servers are rate-limiting requests (429). Please try again later; if this keeps happening, contact the developer — the outbound IP may need to change.`;
  }
  if (message.includes('DI token exchange failed')) {
    return `${regionLabel}: DI token exchange failed. Common causes: the service ticket was already used or expired (CAS tickets are usually valid for 5 minutes), or all client_ids are invalid. Click "Connect Garmin" again to get a new ticket.`;
  }
  if (message.includes('No OAuth2 token available')) {
    return `${regionLabel}: sign-in failed — could not obtain an OAuth token. Check your credentials or try again later.`;
  }
  if (message.includes('Cannot find module')) {
    return `${regionLabel}: sign-in dependency missing: ${message}`;
  }
  return message || `${regionLabel}: sign-in failed`;
}
