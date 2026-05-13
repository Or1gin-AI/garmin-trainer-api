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

async function fetchRegion(
  userId: string,
  region: 'cn' | 'global',
  limit: number,
): Promise<{ list: RawActivity[]; error: string | null }> {
  try {
    const { client } = await authenticate(userId, region);
    const list = (await client.getActivities(0, limit)) as RawActivity[];
    if (!Array.isArray(list)) return { list: [], error: null };
    return { list: await enrichActivitiesWithDetails(client, list), error: null };
  } catch (err) {
    return { list: [], error: err instanceof Error ? err.message : String(err) };
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

async function enrichActivitiesWithDetails(
  client: any,
  activities: RawActivity[],
): Promise<RawActivity[]> {
  const enriched = activities.slice();
  const candidates = activities
    .map((activity, index) => ({ activity, index }))
    .filter(({ activity }) => hasHrZoneDetailHint(activity))
    .slice(0, 25);

  await Promise.all(
    candidates.map(async ({ activity, index }) => {
      try {
        const detail = await client.getActivity(activity);
        enriched[index] = {
          ...activity,
          detail,
        } as RawActivity;
      } catch {
        // Detail fetch is best-effort; summary activities are still usable.
      }
    }),
  );

  return enriched;
}

export async function fetchRecentRawActivities(
  userId: string,
  options: FetchRecentOptions = {},
): Promise<FetchRecentResult> {
  const days = options.days ?? DEFAULT_DAYS;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;

  const cnRes = await fetchRegion(userId, 'cn', limit);
  const globalRes = { list: [] as RawActivity[], error: null as string | null };

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

  return {
    activities: filtered,
    cn: { count: cnRes.list.length, error: cnRes.error },
    global: { count: globalRes.list.length, error: globalRes.error },
  };
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
