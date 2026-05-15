import type { NormalizedActivity, NormalizedSport } from '../activity-normalizer.js';
import type { QualityResult } from '../activity-quality.js';
import { classifyStimulus } from '../recent-state.js';

export interface ActivityMetricRowInput {
  id: string;
  userId: string;
  region: 'cn' | 'global';
  activityId: string;
  sport: NormalizedSport;
  subtype: string | null;
  startTime: Date;
  distanceKm: string | null;
  durationMin: string | null;
  elevationGainM: number | null;
  avgPaceSecPerKm: number | null;
  avgPaceSecPer100m: number | null;
  avgPower: number | null;
  normalizedPower: number | null;
  maxPowerTwentyMinutes: number | null;
  functionalThresholdPower: number | null;
  cadenceAvg: number | null;
  groundContactTimeMs: string | null;
  verticalOscillationCm: string | null;
  verticalRatio: string | null;
  avgHr: number | null;
  maxHr: number | null;
  hrZoneSeconds: Record<string, number> | null;
  vo2Max: string | null;
  lactateThresholdHr: number | null;
  lactateThresholdPaceSecPerKm: number | null;
  aerobicTrainingEffect: string | null;
  anaerobicTrainingEffect: string | null;
  trainingLoad: number | null;
  recoveryTimeHours: number | null;
  poolLengthM: number | null;
  swimStroke: string | null;
  stimulus: string | null;
  qualityConfidence: 'low' | 'medium' | 'high';
  fetchedAt: Date;
}

const num = (value: number | null | undefined): string | null =>
  value == null ? null : String(value);

function classifySubtype(activity: NormalizedActivity): string | null {
  const t = activity.type.toLowerCase();
  if (t.includes('treadmill')) return 'treadmill';
  if (t.includes('trail')) return 'trail_run';
  if (t.includes('track')) return 'track';
  if (t === 'running' || t === 'road_running' || t === 'street_running') return 'road_run';
  if (t.includes('open_water')) return 'open_water_swim';
  if (t === 'lap_swimming' || t === 'pool_swimming') return 'pool_swim';
  if (t.includes('indoor_cycling')) return 'indoor_cycling';
  if (t.includes('mountain')) return 'mountain_bike';
  if (t.includes('gravel')) return 'gravel';
  if (t === 'cycling' || t === 'road_cycling' || t === 'road_biking') return 'road_bike';
  return null;
}

function hrZoneSeconds(activity: NormalizedActivity): Record<string, number> | null {
  if (!activity.hrTimeInZones) return null;
  const [z1, z2, z3, z4, z5] = activity.hrTimeInZones;
  return { z1, z2, z3, z4, z5 };
}

function regionFor(activity: NormalizedActivity): 'cn' | 'global' | null {
  if (activity.region === 'cn' || activity.region === 'global') return activity.region;
  return null;
}

// Returns null if the activity lacks identifying fields needed for upsert.
export function toActivityMetricRow(
  userId: string,
  activity: NormalizedActivity,
  quality: QualityResult | undefined,
): ActivityMetricRowInput | null {
  const region = regionFor(activity);
  if (!region) return null;
  if (activity.activityId == null) return null;
  if (!activity.startTimeLocal || Number.isNaN(activity.startTimeLocal.getTime())) {
    return null;
  }

  const activityId = String(activity.activityId);
  const extra = activity as unknown as {
    poolLengthM?: number | null;
    poolLength?: number | null;
    swimStroke?: string | null;
  };

  return {
    id: `${userId}:${region}:${activityId}`,
    userId,
    region,
    activityId,
    sport: activity.sport,
    subtype: classifySubtype(activity),
    startTime: activity.startTimeLocal,
    distanceKm: num(activity.distanceKm),
    durationMin: num(activity.durationMin),
    elevationGainM: activity.elevationGain == null ? null : Math.round(activity.elevationGain),
    avgPaceSecPerKm: activity.averagePaceSecPerKm,
    avgPaceSecPer100m: activity.averagePaceSecPer100m,
    avgPower: activity.averagePower == null ? null : Math.round(activity.averagePower),
    normalizedPower: activity.normalizedPower == null ? null : Math.round(activity.normalizedPower),
    maxPowerTwentyMinutes:
      activity.maxPowerTwentyMinutes == null
        ? null
        : Math.round(activity.maxPowerTwentyMinutes),
    functionalThresholdPower:
      activity.functionalThresholdPower == null
        ? null
        : Math.round(activity.functionalThresholdPower),
    cadenceAvg: activity.averageCadence == null ? null : Math.round(activity.averageCadence),
    groundContactTimeMs: num(activity.groundContactTime),
    verticalOscillationCm: num(activity.verticalOscillation),
    verticalRatio: num(activity.verticalRatio),
    avgHr: activity.averageHr == null ? null : Math.round(activity.averageHr),
    maxHr: activity.maxHr == null ? null : Math.round(activity.maxHr),
    hrZoneSeconds: hrZoneSeconds(activity),
    vo2Max: num(activity.vo2Max),
    lactateThresholdHr:
      activity.lactateThresholdHr == null
        ? null
        : Math.round(activity.lactateThresholdHr),
    lactateThresholdPaceSecPerKm: activity.lactateThresholdPaceSecPerKm,
    aerobicTrainingEffect: num(activity.aerobicTrainingEffect),
    anaerobicTrainingEffect: num(activity.anaerobicTrainingEffect),
    trainingLoad: activity.trainingLoad == null ? null : Math.round(activity.trainingLoad),
    recoveryTimeHours:
      activity.recoveryTimeHours == null
        ? null
        : Math.round(activity.recoveryTimeHours),
    poolLengthM: extra.poolLengthM ?? extra.poolLength ?? null,
    swimStroke: extra.swimStroke ?? null,
    stimulus: classifyStimulus(activity),
    qualityConfidence: quality?.confidence ?? 'medium',
    fetchedAt: new Date(),
  };
}
