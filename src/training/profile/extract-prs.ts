import type { NormalizedActivity } from '../activity-normalizer.js';

export type Anchor =
  | 'run:1K'
  | 'run:3K'
  | 'run:5K'
  | 'run:10K'
  | 'run:HM'
  | 'run:FM'
  | 'swim:200m'
  | 'swim:400m'
  | 'swim:800m'
  | 'swim:1500m'
  | 'bike:20min'
  | 'bike:60min';

export interface PrCandidate {
  anchor: Anchor;
  value: number; // seconds for run/swim, watts for bike
  unit: 'seconds' | 'watts';
  achievedAt: Date;
  sourceActivityId: string;
  sourceRegion: 'cn' | 'global';
  confidence: 'low' | 'medium' | 'high';
}

export interface ExtractInput {
  activities: NormalizedActivity[];
  excludedKeys: Set<string>; // region:activityId
}

interface RunBand {
  anchor: Anchor;
  minKm: number;
  maxKm: number;
  targetM: number;
  naturalDurationSec: number;
}

const RUN_BANDS: RunBand[] = [
  { anchor: 'run:1K', minKm: 0.95, maxKm: 1.5, targetM: 1000, naturalDurationSec: 300 },
  { anchor: 'run:3K', minKm: 2.7, maxKm: 4, targetM: 3000, naturalDurationSec: 900 },
  { anchor: 'run:5K', minKm: 4.5, maxKm: 6, targetM: 5000, naturalDurationSec: 1500 },
  { anchor: 'run:10K', minKm: 9, maxKm: 12, targetM: 10000, naturalDurationSec: 3300 },
  { anchor: 'run:HM', minKm: 19, maxKm: 23, targetM: 21097.5, naturalDurationSec: 7200 },
  { anchor: 'run:FM', minKm: 40, maxKm: 44, targetM: 42195, naturalDurationSec: 15000 },
];

interface SwimBand {
  anchor: Anchor;
  minKm: number;
  maxKm: number;
}

const SWIM_BANDS: SwimBand[] = [
  { anchor: 'swim:200m', minKm: 0.18, maxKm: 0.25 },
  { anchor: 'swim:400m', minKm: 0.36, maxKm: 0.45 },
  { anchor: 'swim:800m', minKm: 0.7, maxKm: 0.9 },
  { anchor: 'swim:1500m', minKm: 1.4, maxKm: 1.7 },
];

interface BikeBand {
  anchor: Anchor;
  minMin: number;
  maxMin: number;
}

const BIKE_BANDS: BikeBand[] = [
  { anchor: 'bike:20min', minMin: 18, maxMin: 30 },
  { anchor: 'bike:60min', minMin: 55, maxMin: 90 },
];

// Pete Riegel, "Athletic Records and Human Endurance", 1981:
// t2 = t1 * (d2 / d1)^1.06. See docs/sports-science-algorithms.md.
const RIEGEL_EXP = 1.06;

function riegel(actualDurSec: number, actualDistM: number, targetDistM: number): number {
  return actualDurSec * Math.pow(targetDistM / actualDistM, RIEGEL_EXP);
}

function activityKey(activity: NormalizedActivity): string | null {
  if (activity.activityId == null) return null;
  return String(activity.activityId);
}

function activityRegion(activity: NormalizedActivity): 'cn' | 'global' | null {
  if (activity.region === 'cn' || activity.region === 'global') return activity.region;
  return null;
}

function activityDate(activity: NormalizedActivity): Date | null {
  const d = activity.startTimeLocal;
  if (!d || Number.isNaN(d.getTime())) return null;
  return d;
}

export function extractPrCandidates(input: ExtractInput): PrCandidate[] {
  const out: PrCandidate[] = [];

  for (const activity of input.activities) {
    const key = activityKey(activity);
    const region = activityRegion(activity);
    const date = activityDate(activity);
    if (!key || !region || !date) continue;
    if (input.excludedKeys.has(`${region}:${key}`)) continue;

    const distKm = activity.distanceKm ?? 0;
    const durSec = (activity.durationMin ?? 0) * 60;

    if (activity.sport === 'running') {
      if (distKm <= 0 || durSec <= 0) continue;
      for (const band of RUN_BANDS) {
        if (distKm < band.minKm || distKm > band.maxKm) continue;
        const distM = distKm * 1000;
        const isExtrapolated = Math.abs(distM - band.targetM) > band.targetM * 0.02;
        const value = isExtrapolated ? riegel(durSec, distM, band.targetM) : durSec;
        const hrOk = activity.averageHr !== null && activity.averageHr >= 110;
        const confidence =
          durSec < band.naturalDurationSec * 0.5
            ? 'low'
            : isExtrapolated || !hrOk
              ? 'medium'
              : 'high';
        out.push({
          anchor: band.anchor,
          value,
          unit: 'seconds',
          achievedAt: date,
          sourceActivityId: key,
          sourceRegion: region,
          confidence,
        });
      }
    }

    if (activity.sport === 'swimming') {
      if (distKm <= 0 || durSec <= 0) continue;
      for (const band of SWIM_BANDS) {
        if (distKm < band.minKm || distKm > band.maxKm) continue;
        out.push({
          anchor: band.anchor,
          value: durSec,
          unit: 'seconds',
          achievedAt: date,
          sourceActivityId: key,
          sourceRegion: region,
          confidence: activity.averageHr !== null && activity.averageHr >= 100 ? 'high' : 'medium',
        });
      }
    }

    if (activity.sport === 'cycling') {
      const power = activity.averagePower ?? 0;
      const durMin = activity.durationMin ?? 0;
      if (power <= 0 || durMin <= 0) continue;
      for (const band of BIKE_BANDS) {
        if (durMin < band.minMin || durMin > band.maxMin) continue;
        out.push({
          anchor: band.anchor,
          value: power,
          unit: 'watts',
          achievedAt: date,
          sourceActivityId: key,
          sourceRegion: region,
          confidence: durMin >= band.minMin * 1.05 ? 'high' : 'medium',
        });
      }
    }
  }

  return out;
}

export function pickBestPerAnchor(candidates: PrCandidate[]): Map<Anchor, PrCandidate> {
  const map = new Map<Anchor, PrCandidate>();
  for (const candidate of candidates) {
    const current = map.get(candidate.anchor);
    if (!current || isBetter(candidate, current)) {
      map.set(candidate.anchor, candidate);
    }
  }
  return map;
}

function confidenceRank(confidence: PrCandidate['confidence']): number {
  if (confidence === 'high') return 2;
  if (confidence === 'medium') return 1;
  return 0;
}

function isBetter(a: PrCandidate, b: PrCandidate): boolean {
  const rankA = confidenceRank(a.confidence);
  const rankB = confidenceRank(b.confidence);
  if (rankA !== rankB) return rankA > rankB;
  if (a.unit === 'seconds') {
    if (a.value !== b.value) return a.value < b.value;
  } else if (a.value !== b.value) {
    return a.value > b.value;
  }
  return a.achievedAt > b.achievedAt;
}
