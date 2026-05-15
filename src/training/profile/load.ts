import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { athleticProfile, type AthleticProfileRow } from '../../db/schema.js';
import type {
  AthleteProfile,
  AthleteProfileCycling,
  AthleteProfileHeartRate,
  AthleteProfileRunning,
  AthleteProfileSwimming,
} from '../athlete-profile.js';

export interface LoadAthleteProfileResult {
  profile: AthleteProfile;
  isColdStart: boolean;
}

export async function loadAthleteProfileFromDb(
  userId: string,
  injuries: string[] = [],
): Promise<LoadAthleteProfileResult> {
  const rows = await db
    .select()
    .from(athleticProfile)
    .where(eq(athleticProfile.userId, userId));

  if (rows.length === 0) {
    return { profile: stubProfile(injuries), isColdStart: true };
  }

  const isColdStart = rows.every(
    (row) => !row.available || row.activityCountUsed <= 0,
  );
  const bySport = new Map(rows.map((row) => [row.sport, row]));
  const running =
    snapshotFor<AthleteProfileRunning>(bySport.get('running')) ?? blankRunning();
  const cycling =
    snapshotFor<AthleteProfileCycling>(bySport.get('cycling')) ?? blankCycling();
  const swimming =
    snapshotFor<AthleteProfileSwimming>(bySport.get('swimming')) ?? blankSwimming();
  const heartRate =
    heartRateFromSnapshot(bySport.get('running')) ??
    heartRateFromSnapshot(bySport.get('cycling')) ??
    heartRateFromSnapshot(bySport.get('swimming')) ??
    null;

  return {
    profile: {
      heartRate,
      running,
      cycling,
      swimming,
      injuries,
      experienceLevel: isColdStart ? 'beginner' : deriveExperience(rows),
    },
    isColdStart,
  };
}

function snapshotFor<T>(row: AthleticProfileRow | undefined): T | null {
  if (!row || !row.snapshot || typeof row.snapshot !== 'object') return null;
  return row.snapshot as T;
}

function heartRateFromSnapshot(
  row: AthleticProfileRow | undefined,
): AthleteProfileHeartRate | null {
  const snapshot = snapshotFor<Record<string, unknown>>(row);
  const zones = snapshot?.heartRateZones;
  if (!zones || typeof zones !== 'object') return null;
  return zones as AthleteProfileHeartRate;
}

function deriveExperience(
  rows: Array<{ activityCountUsed: number }>,
): AthleteProfile['experienceLevel'] {
  const total = rows.reduce((sum, row) => sum + row.activityCountUsed, 0);
  if (total >= 60) return 'advanced';
  if (total >= 20) return 'intermediate';
  return 'beginner';
}

function stubProfile(injuries: string[]): AthleteProfile {
  return {
    heartRate: null,
    running: blankRunning(),
    cycling: blankCycling(),
    swimming: blankSwimming(),
    injuries,
    experienceLevel: 'beginner',
  };
}

function blankRunning(): AthleteProfileRunning {
  return { available: false, confidence: 'low' };
}

function blankCycling(): AthleteProfileCycling {
  return { available: false, confidence: 'low' };
}

function blankSwimming(): AthleteProfileSwimming {
  return { available: false, confidence: 'low' };
}
