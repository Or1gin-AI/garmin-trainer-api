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
  maxHr: number | null;
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
  maxPower: number | null;
  maxPowerTwentyMinutes: number | null;
  functionalThresholdPower: number | null;
  averageCadence: number | null;
  maxCadence: number | null;
  groundContactTime: number | null; // ms
  verticalOscillation: number | null; // cm, Garmin commonly reports mm/cm depending on endpoint
  verticalRatio: number | null; // %
  strideLength: number | null; // m
  vo2Max: number | null;
  lactateThresholdHr: number | null;
  lactateThresholdPaceSecPerKm: number | null;
  trainingStatus: string | null;
  hrvStatus: string | null;
  sleepDurationHours: number | null;
  sleepScore: number | null;
  recoveryTimeHours: number | null;
  heartRateZones: Array<[number, number]>;
  hrTimeInZones: [number, number, number, number, number] | null;
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

function readHeartRateZones(value: unknown): Array<[number, number]> {
  if (!Array.isArray(value)) return [];
  const zones: Array<[number, number]> = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const low = readNumber(item[0]);
    const high = readNumber(item[1]);
    if (low !== null && high !== null && high > low) {
      zones.push([Math.round(low), Math.round(high)]);
    }
  }
  return zones;
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

function readHrTimeInZones(obj: Record<string, unknown>): [number, number, number, number, number] | null {
  const z1 = readNumber(obj.hrTimeInZone_1);
  const z2 = readNumber(obj.hrTimeInZone_2);
  const z3 = readNumber(obj.hrTimeInZone_3);
  const z4 = readNumber(obj.hrTimeInZone_4);
  const z5 = readNumber(obj.hrTimeInZone_5);
  if (z1 === null && z2 === null && z3 === null && z4 === null && z5 === null) return null;
  return [z1 ?? 0, z2 ?? 0, z3 ?? 0, z4 ?? 0, z5 ?? 0];
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

  const lactateThresholdPaceMinPerKm = readNumber(obj.lactateThresholdPaceMinPerKm);
  const lactateThresholdPaceSecPerKm =
    lactateThresholdPaceMinPerKm !== null && lactateThresholdPaceMinPerKm > 0
      ? Math.round(lactateThresholdPaceMinPerKm * 60)
      : null;

  const averageSpeed = readNumber(obj.averageSpeed);

  // Swimming pace per 100m: prefer Garmin's speed field because total
  // duration usually includes wall/rest time for pool sessions. Falling back
  // to duration/distance is still useful for imports that lack speed.
  let averagePaceSecPer100m: number | null = null;
  if (sport === 'swimming') {
    if (averageSpeed !== null && averageSpeed > 0) {
      const paceFromSpeed = Math.round(100 / averageSpeed);
      if (paceFromSpeed >= 35 && paceFromSpeed <= 600) {
        averagePaceSecPer100m = paceFromSpeed;
      }
    }
    if (averagePaceSecPer100m === null && distanceKm > 0 && durationMin > 0) {
      averagePaceSecPer100m = Math.round((durationMin * 60) / (distanceKm * 10));
    }
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
    maxHr: readNumber(obj.maxHr),
    averagePaceSecPerKm,
    averagePaceSecPer100m,
    trainingLoad: readNumber(obj.trainingLoad),
    trainingEffectLabel: readString(obj.trainingEffectLabel),
    aerobicTrainingEffect: readNumber(obj.aerobicTrainingEffect),
    anaerobicTrainingEffect: readNumber(obj.anaerobicTrainingEffect),
    primaryBenefit: readString(obj.primaryBenefit),
    averageSpeed,
    averagePower: readNumber(obj.averagePower),
    normalizedPower: readNumber(obj.normalizedPower),
    maxPower: readNumber(obj.maxPower),
    maxPowerTwentyMinutes: readNumber(obj.maxPowerTwentyMinutes),
    functionalThresholdPower: readNumber(obj.functionalThresholdPower),
    averageCadence: readNumber(obj.averageCadence),
    maxCadence: readNumber(obj.maxCadence),
    groundContactTime: readNumber(obj.groundContactTime),
    verticalOscillation: readNumber(obj.verticalOscillation),
    verticalRatio: readNumber(obj.verticalRatio),
    strideLength: readNumber(obj.strideLength),
    vo2Max: readNumber(obj.vo2Max),
    lactateThresholdHr: readNumber(obj.lactateThresholdHr),
    lactateThresholdPaceSecPerKm,
    trainingStatus: readString(obj.trainingStatus),
    hrvStatus: readString(obj.hrvStatus),
    sleepDurationHours: readNumber(obj.sleepDurationHours),
    sleepScore: readNumber(obj.sleepScore),
    recoveryTimeHours: readNumber(obj.recoveryTimeHours),
    heartRateZones: readHeartRateZones(obj.heartRateZones),
    hrTimeInZones: readHrTimeInZones(obj),
    elevationGain: readNumber(obj.elevationGain),
    deviceName: readString(obj.deviceName),
  };
}
