import { Router } from 'express';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  activityMetric,
  athleticProfile,
  performanceRecord,
  userActivityFlag,
} from '../db/schema.js';
import { requireUser, type AuthedRequest } from '../lib/session.js';

export const profileRouter = Router();

profileRouter.get('/', requireUser, async (req, res) => {
  const userId = (req as AuthedRequest).user.id;
  const [profiles, prs, activities, flags] = await Promise.all([
    db.select().from(athleticProfile).where(eq(athleticProfile.userId, userId)),
    db.select().from(performanceRecord).where(eq(performanceRecord.userId, userId)),
    db
      .select()
      .from(activityMetric)
      .where(eq(activityMetric.userId, userId))
      .orderBy(desc(activityMetric.startTime))
      .limit(200),
    db.select().from(userActivityFlag).where(eq(userActivityFlag.userId, userId)),
  ]);

  const excluded = new Set(
    flags
      .filter((flag) => flag.excludeFromCapability)
      .map((flag) => `${flag.region}:${flag.activityId}`),
  );

  res.json({
    sports: profiles.map((profile) => ({
      sport: profile.sport,
      available: profile.available,
      confidence: profile.confidence,
      primaryMetric:
        profile.primaryMetric != null ? Number(profile.primaryMetric) : null,
      primaryMetricUnit: profile.primaryMetricUnit,
      primaryMetricSource: profile.primaryMetricSource,
      snapshot: profile.snapshot,
      activityCountUsed: profile.activityCountUsed,
      lastActivityAt: profile.lastActivityAt,
      updatedAt: profile.updatedAt,
    })),
    performanceRecords: prs.map((record) => ({
      sport: record.sport,
      anchor: record.anchor,
      bestValue: Number(record.bestValue),
      bestUnit: record.bestUnit,
      achievedAt: record.achievedAt,
      sourceActivityId: record.sourceActivityId,
      sourceRegion: record.sourceRegion,
      confidence: record.confidence,
      isUserEntered: record.isUserEntered,
    })),
    activities: activities.map((activity) => ({
      activityId: activity.activityId,
      region: activity.region,
      sport: activity.sport,
      startTime: activity.startTime,
      distanceKm: activity.distanceKm != null ? Number(activity.distanceKm) : null,
      durationMin:
        activity.durationMin != null ? Number(activity.durationMin) : null,
      avgPaceSecPerKm: activity.avgPaceSecPerKm,
      avgPaceSecPer100m: activity.avgPaceSecPer100m,
      avgHr: activity.avgHr,
      avgPower: activity.avgPower,
      qualityConfidence: activity.qualityConfidence,
      excluded: excluded.has(`${activity.region}:${activity.activityId}`),
    })),
  });
});
