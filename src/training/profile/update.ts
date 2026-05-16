import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  activityMetric,
  athleticProfile,
  performanceRecord,
  userActivityFlag,
  type ActivityMetricRow,
} from '../../db/schema.js';
import type { NormalizedActivity, NormalizedSport } from '../activity-normalizer.js';
import { buildAthleteProfile } from '../athlete-profile.js';
import {
  classifyActivityQuality,
  type QualityContext,
  type QualityResult,
} from '../activity-quality.js';
import type { GarminPhysiologyMetrics } from '../../garmin/fetch-recent.js';
import {
  extractPrCandidates,
  pickBestPerAnchor,
  type Anchor,
  type PrCandidate,
} from './extract-prs.js';
import { deriveCycling, deriveRunning, deriveSwimming } from './derive-zones.js';

const PROFILE_LOOKBACK_DAYS = 56;
const DAY_MS = 24 * 60 * 60 * 1000;

function rowSport(row: ActivityMetricRow): NormalizedSport {
  if (
    row.sport === 'running' ||
    row.sport === 'cycling' ||
    row.sport === 'swimming' ||
    row.sport === 'other'
  ) {
    return row.sport;
  }
  return 'other';
}

function rowToHrTimeInZones(value: unknown): [number, number, number, number, number] | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const zones = ['z1', 'z2', 'z3', 'z4', 'z5'].map((key) => {
    const n = Number(obj[key] ?? 0);
    return Number.isFinite(n) ? n : 0;
  });
  if (zones.every((n) => n === 0)) return null;
  return zones as [number, number, number, number, number];
}

function rowToNormalized(row: ActivityMetricRow): NormalizedActivity {
  const sport = rowSport(row);
  return {
    id: `${row.region}-${row.activityId}`,
    activityId: row.activityId,
    region: row.region === 'global' ? 'global' : 'cn',
    source: 'garmin',
    type: row.subtype ?? row.sport,
    sport,
    startTimeLocal: row.startTime,
    distanceKm: row.distanceKm != null ? Number(row.distanceKm) : 0,
    durationMin: row.durationMin != null ? Number(row.durationMin) : 0,
    averageHr: row.avgHr,
    maxHr: row.maxHr,
    averagePaceSecPerKm: row.avgPaceSecPerKm,
    averagePaceSecPer100m: row.avgPaceSecPer100m,
    trainingLoad: row.trainingLoad,
    trainingEffectLabel: row.stimulus,
    aerobicTrainingEffect:
      row.aerobicTrainingEffect != null ? Number(row.aerobicTrainingEffect) : null,
    anaerobicTrainingEffect:
      row.anaerobicTrainingEffect != null ? Number(row.anaerobicTrainingEffect) : null,
    primaryBenefit: row.stimulus,
    averageSpeed:
      row.distanceKm != null && row.durationMin != null && Number(row.durationMin) > 0
        ? (Number(row.distanceKm) * 1000) / (Number(row.durationMin) * 60)
        : null,
    averagePower: row.avgPower,
    normalizedPower: row.normalizedPower,
    maxPower: null,
    maxPowerTwentyMinutes: row.maxPowerTwentyMinutes,
    functionalThresholdPower: row.functionalThresholdPower,
    averageCadence: row.cadenceAvg,
    maxCadence: null,
    groundContactTime:
      row.groundContactTimeMs != null ? Number(row.groundContactTimeMs) : null,
    verticalOscillation:
      row.verticalOscillationCm != null ? Number(row.verticalOscillationCm) : null,
    verticalRatio: row.verticalRatio != null ? Number(row.verticalRatio) : null,
    strideLength: null,
    vo2Max: row.vo2Max != null ? Number(row.vo2Max) : null,
    lactateThresholdHr: row.lactateThresholdHr,
    lactateThresholdPaceSecPerKm: row.lactateThresholdPaceSecPerKm,
    trainingStatus: null,
    hrvStatus: null,
    sleepDurationHours: null,
    sleepScore: null,
    recoveryTimeHours: row.recoveryTimeHours,
    heartRateZones: [],
    hrTimeInZones: rowToHrTimeInZones(row.hrZoneSeconds),
    elevationGain: row.elevationGainM,
    deviceName: null,
  };
}

function buildQualityContext(activities: NormalizedActivity[]): QualityContext {
  const bySport = (sport: NormalizedSport) =>
    activities.filter((activity) => activity.sport === sport);

  const sportMedianDistanceKm: Partial<Record<NormalizedSport, number>> = {};
  const sportP90DistanceKm: Partial<Record<NormalizedSport, number>> = {};
  const sportMedianDurationMin: Partial<Record<NormalizedSport, number>> = {};
  const sportP90DurationMin: Partial<Record<NormalizedSport, number>> = {};
  const sportMedianTrainingLoad: Partial<Record<NormalizedSport, number>> = {};

  for (const sport of ['running', 'cycling', 'swimming'] as const) {
    const list = bySport(sport);
    const distances = list.map((a) => a.distanceKm).filter(validMetric);
    const durations = list.map((a) => a.durationMin).filter(validMetric);
    const loads = list.map((a) => a.trainingLoad).filter(validMetric);
    const distMedian = medianNumber(distances);
    const distP90 = percentileNumber(distances, 0.9);
    const durationMedian = medianNumber(durations);
    const durationP90 = percentileNumber(durations, 0.9);
    const loadMedian = medianNumber(loads);
    if (distMedian !== null) sportMedianDistanceKm[sport] = distMedian;
    if (distP90 !== null) sportP90DistanceKm[sport] = distP90;
    if (durationMedian !== null) sportMedianDurationMin[sport] = durationMedian;
    if (durationP90 !== null) sportP90DurationMin[sport] = durationP90;
    if (loadMedian !== null) sportMedianTrainingLoad[sport] = loadMedian;
  }

  return {
    cyclingMedianSpeedMps: medianNumber(
      bySport('cycling').map((a) => a.averageSpeed).filter(validMetric),
    ),
    runningMedianPaceSecPerKm: medianNumber(
      bySport('running').map((a) => a.averagePaceSecPerKm).filter(validMetric),
    ),
    runningMedianPowerWatts: medianNumber(
      bySport('running').map((a) => a.averagePower).filter(validMetric),
    ),
    sportMedianDistanceKm,
    sportP90DistanceKm,
    sportMedianDurationMin,
    sportP90DurationMin,
    sportMedianTrainingLoad,
  };
}

export async function updateUserProfile(
  userId: string,
  physiology?: GarminPhysiologyMetrics | null,
): Promise<void> {
  const cutoff = new Date(Date.now() - PROFILE_LOOKBACK_DAYS * DAY_MS);
  const [metricRows, flagRows] = await Promise.all([
    db
      .select()
      .from(activityMetric)
      .where(
        and(
          eq(activityMetric.userId, userId),
          eq(activityMetric.region, 'cn'),
          gte(activityMetric.startTime, cutoff),
        ),
      ),
    db
      .select()
      .from(userActivityFlag)
      .where(
        and(
          eq(userActivityFlag.userId, userId),
          eq(userActivityFlag.excludeFromCapability, true),
        ),
      ),
  ]);
  if (metricRows.length === 0) {
    await db.transaction(async (tx) => {
      await tx
        .delete(performanceRecord)
        .where(
          and(
            eq(performanceRecord.userId, userId),
            eq(performanceRecord.isUserEntered, false),
          ),
        );
      await tx
        .delete(athleticProfile)
        .where(eq(athleticProfile.userId, userId));
    });
    return;
  }

  const excludedKeys = new Set(
    flagRows.map((flag) => `${flag.region}:${flag.activityId}`),
  );
  const includedRows = metricRows.filter(
    (row) => !excludedKeys.has(`${row.region}:${row.activityId}`),
  );

  const activityRows = includedRows.map((row) => ({
    row,
    activity: rowToNormalized(row),
  }));
  const activities = activityRows.map(({ activity }) => activity);
  const qualityContext = buildQualityContext(activities);
  const qualities = new Map<string, QualityResult>(
    activities.map((activity) => [
      activity.id,
      classifyActivityQuality(activity, qualityContext),
    ]),
  );
  const prActivities = activityRows
    .filter(({ activity }) => qualities.get(activity.id)?.confidence !== 'low')
    .map(({ activity }) => activity);

  const bestPrs = pickBestPerAnchor(
    extractPrCandidates({ activities: prActivities, excludedKeys: new Set() }),
  );
  await upsertPerformanceRecords(userId, bestPrs);

  const fullProfile = buildAthleteProfile({
    activities,
    qualities,
    physiology,
    request: {},
  });

  // Pass Garmin-authoritative values (FTP from power meter, CSS from biometric
  // profile) into derive-zones so it skips PR-based estimation when Garmin
  // already knows the answer. PR estimation is fallback only.
  const running = deriveRunning(bestPrs);
  const swimming = deriveSwimming(
    bestPrs,
    fullProfile.swimming.cssPaceSecPer100m ?? null,
  );
  const cycling = deriveCycling(bestPrs, fullProfile.cycling.ftpWatts ?? null);
  const lastActivityAt = latestActivityAt(activities, qualities);

  // Snapshot merge priority: fullProfile (Garmin direct + activity-sample
  // statistics) wins over derive-zones (PR-based estimation). derive-zones
  // only fills in fields fullProfile cannot compute.
  const runningSnapshot = {
    ...fullProfile.running,
    available: fullProfile.running.available || running.available,
    vdot: running.vdot,
    easyPaceSecPerKm: fullProfile.running.easyPaceSecPerKm ?? running.easyPaceSecPerKm,
    longPaceSecPerKm: fullProfile.running.longPaceSecPerKm ?? running.longPaceSecPerKm,
    thresholdPaceSecPerKm:
      fullProfile.running.thresholdPaceSecPerKm ?? running.thresholdPaceSecPerKm,
    vo2PaceSecPerKm: fullProfile.running.vo2PaceSecPerKm ?? running.vo2PaceSecPerKm,
    intervalPaceSecPerKm:
      fullProfile.running.intervalPaceSecPerKm ?? running.intervalPaceSecPerKm,
    sourceAnchor: running.sourceAnchor,
    heartRateZones: fullProfile.heartRate,
  };
  const swimmingCss =
    fullProfile.swimming.cssPaceSecPer100m ?? swimming.cssSecPer100m ?? null;
  const swimmingSnapshot = {
    ...fullProfile.swimming,
    available: fullProfile.swimming.available || swimming.available,
    cssSecPer100m: swimmingCss,
    cssPaceSecPer100m: swimmingCss,
    easyPaceSecPer100m:
      fullProfile.swimming.easyPaceSecPer100m ?? swimming.easyPaceSecPer100m,
    endurancePaceSecPer100m:
      fullProfile.swimming.endurancePaceSecPer100m ?? swimming.endurancePaceSecPer100m,
    aerobicPaceSecPer100m:
      fullProfile.swimming.aerobicPaceSecPer100m ?? swimming.aerobicPaceSecPer100m,
    thresholdPaceSecPer100m: swimmingCss,
    vo2PaceSecPer100m:
      fullProfile.swimming.vo2PaceSecPer100m ?? swimming.vo2PaceSecPer100m,
    sprintPaceSecPer100m:
      fullProfile.swimming.sprintPaceSecPer100m ?? swimming.sprintPaceSecPer100m,
    sourceAnchors: swimming.sourceAnchors,
    heartRateZones: fullProfile.heartRate,
  };
  const cyclingFtp = fullProfile.cycling.ftpWatts ?? cycling.ftpWatts ?? null;
  const cyclingSnapshot = {
    ...fullProfile.cycling,
    available: fullProfile.cycling.available || cycling.available,
    ftpWatts: cyclingFtp,
    enduranceWatts: cycling.enduranceWatts,
    tempoWatts: cycling.tempoWatts,
    thresholdWatts: cycling.thresholdWatts,
    vo2Watts: cycling.vo2Watts,
    sourceAnchor: cycling.sourceAnchor,
    heartRateZones: fullProfile.heartRate,
  };

  await Promise.all([
    upsertSport({
      userId,
      sport: 'running',
      snapshot: runningSnapshot,
      primaryMetricUnit: 'vdot',
      primaryMetric: running.vdot,
      activityCountUsed: activityCountForSport(activities, 'running', qualities),
      lastActivityAt,
    }),
    upsertSport({
      userId,
      sport: 'swimming',
      snapshot: swimmingSnapshot,
      primaryMetricUnit: 's_per_100m',
      primaryMetric: swimmingCss,
      activityCountUsed: activityCountForSport(activities, 'swimming', qualities),
      lastActivityAt,
    }),
    upsertSport({
      userId,
      sport: 'cycling',
      snapshot: cyclingSnapshot,
      primaryMetricUnit: 'watts',
      primaryMetric: cyclingFtp,
      activityCountUsed: activityCountForSport(activities, 'cycling', qualities),
      lastActivityAt,
    }),
  ]);
}

async function upsertPerformanceRecords(
  userId: string,
  bestPrs: Map<Anchor, PrCandidate>,
): Promise<void> {
  const rows = Array.from(bestPrs.entries()).map(([anchor, pr]) => ({
    id: `${userId}:${anchor}`,
    userId,
    sport: anchorSport(anchor),
    anchor,
    bestValue: String(pr.value),
    bestUnit: pr.unit,
    achievedAt: pr.achievedAt,
    sourceActivityId: pr.sourceActivityId,
    sourceRegion: pr.sourceRegion,
    confidence: pr.confidence,
    isUserEntered: false,
    updatedAt: new Date(),
  }));

  await db.transaction(async (tx) => {
    await tx
      .delete(performanceRecord)
      .where(
        and(
          eq(performanceRecord.userId, userId),
          eq(performanceRecord.isUserEntered, false),
        ),
      );
    if (rows.length === 0) return;
    await tx.insert(performanceRecord).values(rows).onConflictDoNothing();
  });
}

function anchorSport(anchor: Anchor): 'running' | 'swimming' | 'cycling' {
  if (anchor.startsWith('run:')) return 'running';
  if (anchor.startsWith('swim:')) return 'swimming';
  return 'cycling';
}

function latestActivityAt(
  activities: NormalizedActivity[],
  qualities: Map<string, QualityResult>,
): Date | null {
  let latest: Date | null = null;
  for (const activity of activities) {
    if (qualities.get(activity.id)?.confidence === 'low') continue;
    const date = activity.startTimeLocal;
    if (date && !Number.isNaN(date.getTime()) && (!latest || date > latest)) {
      latest = date;
    }
  }
  return latest;
}

function activityCountForSport(
  activities: NormalizedActivity[],
  sport: 'running' | 'swimming' | 'cycling',
  qualities: Map<string, QualityResult>,
): number {
  return activities.filter(
    (activity) =>
      activity.sport === sport &&
      qualities.get(activity.id)?.confidence !== 'low',
  ).length;
}

function validMetric(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0;
}

function medianNumber(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function percentileNumber(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * q)),
  );
  return sorted[idx];
}

async function upsertSport(args: {
  userId: string;
  sport: 'running' | 'swimming' | 'cycling';
  snapshot: { available: boolean; confidence?: string };
  primaryMetricUnit: string;
  primaryMetric: number | null | undefined;
  activityCountUsed: number;
  lastActivityAt: Date | null;
}): Promise<void> {
  const confidence =
    !args.snapshot.available
      ? 'low'
      : args.activityCountUsed >= 8
        ? 'high'
        : args.activityCountUsed >= 3
          ? 'medium'
          : 'low';

  await db
    .insert(athleticProfile)
    .values({
      userId: args.userId,
      sport: args.sport,
      available: args.snapshot.available,
      confidence,
      primaryMetric: args.primaryMetric != null ? String(args.primaryMetric) : null,
      primaryMetricUnit: args.primaryMetricUnit,
      primaryMetricSource: 'computed',
      snapshot: args.snapshot,
      activityCountUsed: args.activityCountUsed,
      lastActivityAt: args.lastActivityAt,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [athleticProfile.userId, athleticProfile.sport],
      set: {
        available: sql`EXCLUDED.available`,
        confidence: sql`EXCLUDED.confidence`,
        primaryMetric: sql`CASE WHEN ${athleticProfile.primaryMetricSource} = 'user_override' THEN ${athleticProfile.primaryMetric} ELSE EXCLUDED.primary_metric END`,
        primaryMetricUnit: sql`EXCLUDED.primary_metric_unit`,
        snapshot: sql`EXCLUDED.snapshot`,
        activityCountUsed: sql`EXCLUDED.activity_count_used`,
        lastActivityAt: sql`EXCLUDED.last_activity_at`,
        updatedAt: sql`EXCLUDED.updated_at`,
      },
    });
}
