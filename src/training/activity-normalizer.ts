// Pure normalizer that turns rows from `activity_cache.data` (the jsonb
// payload produced by U2's mapActivity) into a typed shape the rest of the
// activity-processing layer (quality / recent-state / athlete-profile) can
// consume without further coercion.
//
// No I/O. The caller (U7 orchestrator) is responsible for fetching rows
// from Postgres and passing the .data jsonb into normalizeActivity().

export type NormalizedSport = 'running' | 'cycling' | 'swimming' | 'other';

export interface NormalizedActivity {
  id: string; // composed `${region}-${activityId}`
  activityId: string | number;
  region: 'cn' | 'global' | 'manual';
  source: 'garmin' | 'manual';
  type: string; // raw Garmin typeKey ('treadmill_running', etc.)
  sport: NormalizedSport;
  startTimeLocal: Date | null;
  distanceKm: number;
  durationMin: number;
  averageHr: number | null;
  averagePaceSecPerKm: number | null;
  averagePaceSecPer100m: number | null;
  trainingLoad: number | null;
  trainingEffectLabel: string | null;
  aerobicTrainingEffect: number | null;
  anaerobicTrainingEffect: number | null;
  primaryBenefit: string | null;
  averageSpeed: number | null; // m/s
  averagePower: number | null;
  normalizedPower: number | null;
  averageCadence: number | null;
  elevationGain: number | null;
  deviceName: string | null;
}

// ---------------------------------------------------------------------------
// Sport canonicalization
// ---------------------------------------------------------------------------

const RUNNING_TYPES = new Set([
  'running',
  'treadmill_running',
  'trail_running',
  'indoor_running',
  'street_running',
  'track_running',
  'virtual_run',
]);

const CYCLING_TYPES = new Set([
  'cycling',
  'mountain_biking',
  'road_biking',
  'indoor_cycling',
  'gravel_cycling',
  'virtual_ride',
  'commuting',
  'cyclocross',
  'bmx',
]);

const SWIMMING_TYPES = new Set([
  'swimming',
  'lap_swimming',
  'open_water_swimming',
  'pool_swimming',
]);

export function normalizeSport(typeKey: string | null | undefined): NormalizedSport {
  if (!typeKey) return 'other';
  const key = typeKey.toLowerCase();
  if (RUNNING_TYPES.has(key)) return 'running';
  if (CYCLING_TYPES.has(key)) return 'cycling';
  if (SWIMMING_TYPES.has(key)) return 'swimming';
  // Fallback heuristic — Garmin sometimes prefixes new variants we haven't seen.
  if (key.includes('run')) return 'running';
  if (key.includes('cycl') || key.includes('bik')) return 'cycling';
  if (key.includes('swim')) return 'swimming';
  return 'other';
}

// ---------------------------------------------------------------------------
// Field coercion helpers
// ---------------------------------------------------------------------------

function readObj(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function readNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function readString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = typeof value === 'string' ? value : String(value);
  return s.length > 0 ? s : null;
}

function readDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function readRegion(value: unknown): 'cn' | 'global' | 'manual' {
  if (value === 'cn' || value === 'global' || value === 'manual') return value;
  return 'manual';
}

function readSource(value: unknown): 'garmin' | 'manual' {
  return value === 'manual' ? 'manual' : 'garmin';
}

// ---------------------------------------------------------------------------
// Main normalizer
// ---------------------------------------------------------------------------

export function normalizeActivity(raw: unknown): NormalizedActivity | null {
  const obj = readObj(raw);
  if (!obj) return null;

  const activityId = obj.activityId;
  if (
    activityId === undefined ||
    activityId === null ||
    activityId === ''
  ) {
    return null;
  }

  const startTimeLocal = readDate(obj.startTimeLocal);
  const distanceKm = readNumber(obj.distanceKm) ?? 0;
  const durationMin = readNumber(obj.durationMin) ?? 0;

  // Essential fields: must have a valid timestamp and a positive distance/duration.
  // Activities with no time or no movement at all are unparseable for our purposes.
  if (!startTimeLocal) return null;
  if (distanceKm <= 0 && durationMin <= 0) return null;

  const region = readRegion(obj.region);
  const source = readSource(obj.source);
  const type = readString(obj.type) ?? 'unknown';
  const sport = normalizeSport(type);

  // U2's mapActivity stores running pace as minutes-per-km (averagePaceMinPerKm).
  // Convert to seconds-per-km for downstream math. Only meaningful for
  // distance-based sports — we keep it null for non-running.
  const minPerKm = readNumber(obj.averagePaceMinPerKm);
  let averagePaceSecPerKm: number | null = null;
  if (sport === 'running' && minPerKm !== null && minPerKm > 0) {
    averagePaceSecPerKm = Math.round(minPerKm * 60);
  }

  // Swimming pace per 100m: only derive if it's a swim with both distance and
  // duration. Garmin's averagePaceMinPerKm is meaningless for pool swims.
  let averagePaceSecPer100m: number | null = null;
  if (sport === 'swimming' && distanceKm > 0 && durationMin > 0) {
    averagePaceSecPer100m = Math.round((durationMin * 60) / (distanceKm * 10));
  }

  const idStr = readString(obj.id);

  return {
    id: idStr ?? `${region}-${String(activityId)}`,
    activityId: typeof activityId === 'number' ? activityId : String(activityId),
    region,
    source,
    type,
    sport,
    startTimeLocal,
    distanceKm,
    durationMin,
    averageHr: readNumber(obj.averageHr),
    averagePaceSecPerKm,
    averagePaceSecPer100m,
    trainingLoad: readNumber(obj.trainingLoad),
    trainingEffectLabel: readString(obj.trainingEffectLabel),
    aerobicTrainingEffect: readNumber(obj.aerobicTrainingEffect),
    anaerobicTrainingEffect: readNumber(obj.anaerobicTrainingEffect),
    primaryBenefit: readString(obj.primaryBenefit),
    averageSpeed: readNumber(obj.averageSpeed),
    averagePower: readNumber(obj.averagePower),
    normalizedPower: readNumber(obj.normalizedPower),
    averageCadence: readNumber(obj.averageCadence),
    elevationGain: readNumber(obj.elevationGain),
    deviceName: readString(obj.deviceName),
  };
}
