// On-demand activity fetcher for the AI Training Companion.
//
// Pulls the most recent N days of raw activities from Garmin CN and returns
// them in memory. Nothing is persisted —
// the request handler hands the activities to the normalizer and they go
// out of scope when the SSE response ends.
//
// Why no `activity_cache` write: the user wants no long-term storage for
// AI inputs. The bidirectional sync worker is a separate concern (it copies
// activities between Garmin regions, not into our DB).

import { authenticate } from './client.js';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { activityMetric } from '../db/schema.js';
import { normalizeActivity } from '../training/activity-normalizer.js';
import { classifyActivityQuality } from '../training/activity-quality.js';
import { toActivityMetricRow } from '../training/profile/persist-activity.js';
import { updateUserProfile } from '../training/profile/update.js';
import {
  activitySignature,
  mapActivity,
  type MappedActivity,
  type RawActivity,
} from './utils.js';

export interface FetchRecentOptions {
  // Lookback window in days. Activities older than `now - days` are dropped.
  days?: number;
  // Per-region API page size. Garmin returns most-recent-first.
  limit?: number;
}

export interface RegionFetchInfo {
  count: number;
  error: string | null;
}

export interface FetchRecentResult {
  // Activities run through `mapActivity` so the field names match what the
  // training/activity-normalizer.ts pipeline expects (distanceKm, durationMin,
  // averageHr, type, …). Garmin's raw payload uses different keys (distance
  // in meters, duration in seconds, averageHR, activityType.typeKey).
  activities: MappedActivity[];
  physiology: GarminPhysiologyMetrics | null;
  cn: RegionFetchInfo;
  global: RegionFetchInfo;
}

export interface FetchCalendarActivitiesResult {
  activities: MappedActivity[];
  cn: RegionFetchInfo;
  global: RegionFetchInfo;
}

export class GarminUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GarminUnavailableError';
  }
}

const DEFAULT_DAYS = 56;
const DEFAULT_LIMIT = 100;

export interface GarminHeartRateZoneSet {
  sport: string;
  trainingMethod: string | null;
  restingHeartRate: number | null;
  lactateThresholdHeartRate: number | null;
  maxHeartRate: number | null;
  zones: Array<[number, number]>;
}

export interface GarminPhysiologyMetrics {
  heartRateZones: {
    default: GarminHeartRateZoneSet | null;
    cycling: GarminHeartRateZoneSet | null;
    all: GarminHeartRateZoneSet[];
  };
  vo2MaxRunning: number | null;
  vo2MaxCycling: number | null;
  lactateThresholdHeartRate: number | null;
  functionalThresholdPower: number | null;
  criticalSwimSpeed: number | null;
  ftpAutoDetected: boolean | null;
  thresholdHeartRateAutoDetected: boolean | null;
}

async function fetchRegion(
  userId: string,
  region: 'cn' | 'global',
  limit: number,
  options: { includePhysiology?: boolean } = {},
): Promise<{
  list: RawActivity[];
  physiology: GarminPhysiologyMetrics | null;
  error: string | null;
}> {
  try {
    const { client } = await authenticate(userId, region);
    const list = (await client.getActivities(0, limit)) as RawActivity[];
    if (!Array.isArray(list)) {
      const physiology = options.includePhysiology
        ? await fetchGarminPhysiology(client)
        : null;
      return { list: [], physiology, error: null };
    }
    const [enriched, physiology] = await Promise.all([
      enrichActivitiesWithDetails(client, list),
      options.includePhysiology
        ? fetchGarminPhysiology(client)
        : Promise.resolve(null),
    ]);
    return { list: enriched, physiology, error: null };
  } catch (err) {
    return {
      list: [],
      physiology: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function hasHrZoneDetailHint(activity: RawActivity): boolean {
  const raw = activity as unknown as Record<string, unknown>;
  const metadata = raw.metadataDTO as Record<string, unknown> | undefined;
  return (
    metadata?.hasHrTimeInZones === true ||
    raw.hasHrTimeInZones === true ||
    raw.hrTimeInZones !== undefined ||
    raw.heartRateZones !== undefined
  );
}

function activityTypeKey(activity: RawActivity): string {
  const raw = activity as unknown as Record<string, unknown>;
  const activityType = raw.activityType as { typeKey?: string } | undefined;
  const activityTypeDTO = raw.activityTypeDTO as { typeKey?: string } | undefined;
  return String(activityType?.typeKey ?? activityTypeDTO?.typeKey ?? '').toLowerCase();
}

function shouldFetchActivityDetail(activity: RawActivity): boolean {
  const raw = activity as unknown as Record<string, unknown>;
  const metadata = raw.metadataDTO as Record<string, unknown> | undefined;
  const type = activityTypeKey(activity);
  const isTrainingSport =
    type.includes('run') ||
    type.includes('cycl') ||
    type.includes('bik') ||
    type.includes('swim');
  return (
    isTrainingSport ||
    hasHrZoneDetailHint(activity) ||
    metadata?.hasPowerTimeInZones === true ||
    raw.hasPowerTimeInZones === true
  );
}

async function enrichActivitiesWithDetails(
  client: any,
  activities: RawActivity[],
): Promise<RawActivity[]> {
  const enriched = activities.slice();
  const candidates = activities
    .map((activity, index) => ({ activity, index }))
    .filter(({ activity }) => shouldFetchActivityDetail(activity))
    .slice(0, 40);

  await Promise.all(
    candidates.map(async ({ activity, index }) => {
      try {
        const detail = await client.getActivity(activity);
        enriched[index] = {
          ...activity,
          ...(detail && typeof detail === 'object' ? detail : {}),
          detail,
        } as RawActivity;
      } catch {
        // Detail fetch is best-effort; summary activities are still usable.
      }
    }),
  );

  return enriched;
}

async function fetchGarminPhysiology(client: any): Promise<GarminPhysiologyMetrics | null> {
  const [settings, personal, zonePayload] = await Promise.all([
    safeCall(() => client.getUserSettings()),
    safeCall(() => client.getPersonalInfo()),
    safeCall(() => {
      const base = String(client?.url?.GC_API ?? '').replace(/\/$/, '');
      if (!base) return Promise.resolve(null);
      return client.client.get(`${base}/biometric-service/heartRateZones`);
    }),
  ]);

  const userData = readObj((settings as Record<string, unknown> | null)?.userData);
  const biometricProfile = readObj(
    (personal as Record<string, unknown> | null)?.biometricProfile,
  );
  const zones = Array.isArray(zonePayload)
    ? zonePayload
        .map(parseHeartRateZoneSet)
        .filter((z): z is GarminHeartRateZoneSet => z !== null)
    : [];

  return {
    heartRateZones: {
      default: zones.find((z) => z.sport === 'DEFAULT') ?? zones[0] ?? null,
      cycling: zones.find((z) => z.sport === 'CYCLING') ?? null,
      all: zones,
    },
    vo2MaxRunning:
      readNumber(userData?.vo2MaxRunning) ?? readNumber(biometricProfile?.vo2Max),
    vo2MaxCycling:
      readNumber(userData?.vo2MaxCycling) ?? readNumber(biometricProfile?.vo2MaxCycling),
    lactateThresholdHeartRate:
      readNumber(userData?.lactateThresholdHeartRate) ??
      readNumber(biometricProfile?.lactateThresholdHeartRate),
    functionalThresholdPower:
      readNumber(userData?.functionalThresholdPower) ??
      readNumber(biometricProfile?.functionalThresholdPower),
    criticalSwimSpeed:
      readNumber(userData?.criticalSwimSpeed) ??
      readNumber(biometricProfile?.criticalSwimSpeed),
    ftpAutoDetected: readBoolean(userData?.ftpAutoDetected),
    thresholdHeartRateAutoDetected: readBoolean(userData?.thresholdHeartRateAutoDetected),
  };
}

async function safeCall<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

function readObj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function readNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function parseHeartRateZoneSet(raw: unknown): GarminHeartRateZoneSet | null {
  const obj = readObj(raw);
  if (!obj) return null;
  const zone1Floor = readNumber(obj.zone1Floor);
  const zone2Floor = readNumber(obj.zone2Floor);
  const zone3Floor = readNumber(obj.zone3Floor);
  const zone4Floor = readNumber(obj.zone4Floor);
  const zone5Floor = readNumber(obj.zone5Floor);
  const maxHeartRate = readNumber(obj.maxHeartRateUsed);
  if (
    zone1Floor === null ||
    zone2Floor === null ||
    zone3Floor === null ||
    zone4Floor === null ||
    zone5Floor === null
  ) {
    return null;
  }
  const zone5High =
    maxHeartRate !== null && maxHeartRate > zone5Floor
      ? maxHeartRate
      : zone5Floor + Math.max(10, zone5Floor - zone4Floor);
  const floors = [zone1Floor, zone2Floor, zone3Floor, zone4Floor, zone5Floor]
    .map((n) => Math.round(n));
  const zonePairs: Array<[number, number]> = [
    [floors[0], floors[1] - 1],
    [floors[1], floors[2] - 1],
    [floors[2], floors[3] - 1],
    [floors[3], floors[4] - 1],
    [floors[4], Math.round(zone5High)],
  ];
  const zones = zonePairs.filter(([low, high]) => high > low);
  if (zones.length < 5) return null;
  return {
    sport: String(obj.sport ?? 'DEFAULT').toUpperCase(),
    trainingMethod: obj.trainingMethod ? String(obj.trainingMethod) : null,
    restingHeartRate: readNumber(obj.restingHeartRateUsed),
    lactateThresholdHeartRate: readNumber(obj.lactateThresholdHeartRateUsed),
    maxHeartRate: maxHeartRate !== null ? Math.round(maxHeartRate) : null,
    zones,
  };
}

export async function fetchRecentRawActivities(
  userId: string,
  options: FetchRecentOptions = {},
): Promise<FetchRecentResult> {
  const days = options.days ?? DEFAULT_DAYS;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;

  const cnRes = await fetchRegion(userId, 'cn', limit, { includePhysiology: true });
  const globalRes = {
    list: [] as RawActivity[],
    physiology: null as GarminPhysiologyMetrics | null,
    error: null as string | null,
  };

  if (cnRes.error) {
    throw new GarminUnavailableError(
      `无法读取 Garmin 中国区数据：${cnRes.error}`,
    );
  }

  // Training-plan capability estimation is intentionally CN-only. The sync
  // worker may still copy activities across regions, but planning must not
  // mix China and International accounts.
  const seen = new Map<string, MappedActivity>();
  for (const a of cnRes.list) seen.set(activitySignature(a), mapActivity(a, 'cn'));

  const filtered: MappedActivity[] = [];
  for (const a of seen.values()) {
    const ts = a.startTimeLocal ? Date.parse(a.startTimeLocal) : NaN;
    if (Number.isFinite(ts) && ts < cutoffMs) continue;
    filtered.push(a);
  }

  try {
    await persistMetrics(userId, filtered);
  } catch (err) {
    console.error('[fetch-recent] activity_metric persist failed', err);
  }

  try {
    await updateUserProfile(userId, cnRes.physiology);
  } catch (err) {
    console.error('[fetch-recent] profile recompute failed', err);
  }

  return {
    activities: filtered,
    physiology: cnRes.physiology,
    cn: { count: cnRes.list.length, error: cnRes.error },
    global: { count: globalRes.list.length, error: globalRes.error },
  };
}

async function persistMetrics(
  userId: string,
  activities: MappedActivity[],
): Promise<void> {
  const rows = [];
  for (const raw of activities) {
    const normalized = normalizeActivity(raw);
    if (!normalized) continue;
    let quality;
    try {
      quality = classifyActivityQuality(normalized);
    } catch {
      quality = undefined;
    }
    const row = toActivityMetricRow(userId, normalized, quality);
    if (row) rows.push(row);
  }

  if (rows.length === 0) return;

  await db
    .insert(activityMetric)
    .values(rows)
    .onConflictDoUpdate({
      target: activityMetric.id,
      set: {
        sport: sql`EXCLUDED.sport`,
        subtype: sql`EXCLUDED.subtype`,
        startTime: sql`EXCLUDED.start_time`,
        distanceKm: sql`EXCLUDED.distance_km`,
        durationMin: sql`EXCLUDED.duration_min`,
        elevationGainM: sql`EXCLUDED.elevation_gain_m`,
        avgPaceSecPerKm: sql`EXCLUDED.avg_pace_sec_per_km`,
        avgPaceSecPer100m: sql`EXCLUDED.avg_pace_sec_per_100m`,
        avgPower: sql`EXCLUDED.avg_power`,
        normalizedPower: sql`EXCLUDED.normalized_power`,
        maxPowerTwentyMinutes: sql`EXCLUDED.max_power_twenty_minutes`,
        functionalThresholdPower: sql`EXCLUDED.functional_threshold_power`,
        cadenceAvg: sql`EXCLUDED.cadence_avg`,
        groundContactTimeMs: sql`EXCLUDED.ground_contact_time_ms`,
        verticalOscillationCm: sql`EXCLUDED.vertical_oscillation_cm`,
        verticalRatio: sql`EXCLUDED.vertical_ratio`,
        avgHr: sql`EXCLUDED.avg_hr`,
        maxHr: sql`EXCLUDED.max_hr`,
        hrZoneSeconds: sql`EXCLUDED.hr_zone_seconds`,
        vo2Max: sql`EXCLUDED.vo2_max`,
        lactateThresholdHr: sql`EXCLUDED.lactate_threshold_hr`,
        lactateThresholdPaceSecPerKm: sql`EXCLUDED.lactate_threshold_pace_sec_per_km`,
        aerobicTrainingEffect: sql`EXCLUDED.aerobic_te`,
        anaerobicTrainingEffect: sql`EXCLUDED.anaerobic_te`,
        trainingLoad: sql`EXCLUDED.training_load`,
        recoveryTimeHours: sql`EXCLUDED.recovery_time_hours`,
        poolLengthM: sql`EXCLUDED.pool_length_m`,
        swimStroke: sql`EXCLUDED.swim_stroke`,
        stimulus: sql`EXCLUDED.stimulus`,
        qualityConfidence: sql`EXCLUDED.quality_confidence`,
        fetchedAt: sql`EXCLUDED.fetched_at`,
      },
    });
}

export async function fetchCalendarActivities(
  userId: string,
  options: FetchRecentOptions = {},
): Promise<FetchCalendarActivitiesResult> {
  const days = options.days ?? DEFAULT_DAYS;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;

  const [cnRes, globalRes] = await Promise.all([
    fetchRegion(userId, 'cn', limit),
    fetchRegion(userId, 'global', limit),
  ]);

  const seen = new Map<string, MappedActivity>();
  for (const a of cnRes.list) seen.set(activitySignature(a), mapActivity(a, 'cn'));
  for (const a of globalRes.list) seen.set(activitySignature(a), mapActivity(a, 'global'));

  const filtered: MappedActivity[] = [];
  for (const a of seen.values()) {
    const ts = a.startTimeLocal ? Date.parse(a.startTimeLocal) : NaN;
    if (Number.isFinite(ts) && ts < cutoffMs) continue;
    filtered.push(a);
  }

  return {
    activities: filtered,
    cn: { count: cnRes.list.length, error: cnRes.error },
    global: { count: globalRes.list.length, error: globalRes.error },
  };
}
