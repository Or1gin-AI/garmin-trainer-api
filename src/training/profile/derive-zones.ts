import type { Anchor, PrCandidate } from './extract-prs.js';

export interface RunningDerived {
  available: boolean;
  vdot: number | null;
  easyPaceSecPerKm: number | null;
  thresholdPaceSecPerKm: number | null;
  intervalPaceSecPerKm: number | null;
  longPaceSecPerKm: number | null;
  vo2PaceSecPerKm: number | null;
  sourceAnchor: Anchor | null;
}

export interface SwimmingDerived {
  available: boolean;
  cssSecPer100m: number | null;
  easyPaceSecPer100m: number | null;
  endurancePaceSecPer100m: number | null;
  aerobicPaceSecPer100m: number | null;
  thresholdPaceSecPer100m: number | null;
  vo2PaceSecPer100m: number | null;
  sprintPaceSecPer100m: number | null;
  sourceAnchors: Anchor[];
}

export interface CyclingDerived {
  available: boolean;
  ftpWatts: number | null;
  enduranceWatts: number | null;
  tempoWatts: number | null;
  thresholdWatts: number | null;
  vo2Watts: number | null;
  sourceAnchor: Anchor | null;
}

const RUN_ANCHOR_DIST_M: Partial<Record<Anchor, number>> = {
  'run:1K': 1000,
  'run:3K': 3000,
  'run:5K': 5000,
  'run:10K': 10000,
  'run:HM': 21097.5,
  'run:FM': 42195,
};

// Jack Daniels, Daniels' Running Formula: VDOT from race velocity and duration.
// Formula documented in docs/sports-science-algorithms.md.
function vdotFromTime(distM: number, durSec: number): number {
  const tMin = durSec / 60;
  const velocity = distM / tMin; // m/min
  const vo2 = -4.6 + 0.182258 * velocity + 0.000104 * velocity * velocity;
  const pct =
    0.8 +
    0.1894393 * Math.exp(-0.012778 * tMin) +
    0.2989558 * Math.exp(-0.1932605 * tMin);
  return vo2 / pct;
}

function velocityFromVdot(vdot: number): number {
  const a = 0.000104;
  const b = 0.182258;
  const c = -(4.6 + vdot);
  const disc = b * b - 4 * a * c;
  return (-b + Math.sqrt(disc)) / (2 * a);
}

function pacePerKmFromVdotPct(vdot: number, pct: number): number {
  const velocity = velocityFromVdot(vdot) * pct;
  return 60_000 / velocity;
}

export function deriveRunning(prs: Map<Anchor, PrCandidate>): RunningDerived {
  const preferred: Anchor[] = ['run:5K', 'run:10K', 'run:HM', 'run:FM', 'run:3K'];
  let chosen: { anchor: Anchor; pr: PrCandidate; distM: number } | null = null;
  // Prefer high-confidence PRs (exact-distance race-effort runs) over
  // medium-confidence Riegel extrapolations from recovery/slow runs.
  for (const anchor of preferred) {
    const pr = prs.get(anchor);
    const distM = RUN_ANCHOR_DIST_M[anchor];
    if (pr && distM && pr.confidence === 'high') {
      chosen = { anchor, pr, distM };
      break;
    }
  }
  if (!chosen) {
    for (const anchor of preferred) {
      const pr = prs.get(anchor);
      const distM = RUN_ANCHOR_DIST_M[anchor];
      if (pr && distM) {
        chosen = { anchor, pr, distM };
        break;
      }
    }
  }
  if (!chosen) return blankRunning();

  const vdot = vdotFromTime(chosen.distM, chosen.pr.value);
  return {
    available: true,
    vdot: round1(vdot),
    easyPaceSecPerKm: round0(pacePerKmFromVdotPct(vdot, 0.7)),
    longPaceSecPerKm: round0(pacePerKmFromVdotPct(vdot, 0.74)),
    thresholdPaceSecPerKm: round0(pacePerKmFromVdotPct(vdot, 0.88)),
    vo2PaceSecPerKm: round0(pacePerKmFromVdotPct(vdot, 0.98)),
    intervalPaceSecPerKm: round0(pacePerKmFromVdotPct(vdot, 1.0)),
    sourceAnchor: chosen.anchor,
  };
}

function blankRunning(): RunningDerived {
  return {
    available: false,
    vdot: null,
    easyPaceSecPerKm: null,
    thresholdPaceSecPerKm: null,
    intervalPaceSecPerKm: null,
    longPaceSecPerKm: null,
    vo2PaceSecPerKm: null,
    sourceAnchor: null,
  };
}

const SWIM_ANCHOR_DIST_M: Partial<Record<Anchor, number>> = {
  'swim:200m': 200,
  'swim:400m': 400,
  'swim:800m': 800,
  'swim:1500m': 1500,
};

export function deriveSwimming(
  prs: Map<Anchor, PrCandidate>,
  garminCssSecPer100m?: number | null,
): SwimmingDerived {
  // Prefer Garmin's Critical Swim Speed from the biometric profile when available.
  // Wakayoshi CSS from PR pairs is only used when Garmin has no CSS for us.
  if (garminCssSecPer100m != null && garminCssSecPer100m > 0) {
    return swimmingFromCss(garminCssSecPer100m, []);
  }

  const pairs: [Anchor, Anchor][] = [
    ['swim:400m', 'swim:200m'],
    ['swim:800m', 'swim:200m'],
    ['swim:800m', 'swim:400m'],
    ['swim:1500m', 'swim:400m'],
  ];

  for (const [longAnchor, shortAnchor] of pairs) {
    const longPr = prs.get(longAnchor);
    const shortPr = prs.get(shortAnchor);
    if (!longPr || !shortPr) continue;
    const d2 = SWIM_ANCHOR_DIST_M[longAnchor];
    const d1 = SWIM_ANCHOR_DIST_M[shortAnchor];
    if (!d1 || !d2 || longPr.value <= shortPr.value) continue;

    // Wakayoshi et al. 1992 critical swim speed: CSS = (D2-D1)/(t2-t1).
    // Pace zones are percentages of CSS pace, documented in docs/sports-science-algorithms.md.
    const cssMps = (d2 - d1) / (longPr.value - shortPr.value);
    if (!Number.isFinite(cssMps) || cssMps <= 0) continue;
    return swimmingFromCss(100 / cssMps, [longAnchor, shortAnchor]);
  }

  const fallbackOrder: Anchor[] = ['swim:400m', 'swim:800m', 'swim:1500m', 'swim:200m'];
  for (const anchor of fallbackOrder) {
    const pr = prs.get(anchor);
    const distM = SWIM_ANCHOR_DIST_M[anchor];
    if (!pr || !distM) continue;
    return swimmingFromCss((pr.value / distM) * 100, [anchor]);
  }

  return {
    available: false,
    cssSecPer100m: null,
    easyPaceSecPer100m: null,
    endurancePaceSecPer100m: null,
    aerobicPaceSecPer100m: null,
    thresholdPaceSecPer100m: null,
    vo2PaceSecPer100m: null,
    sprintPaceSecPer100m: null,
    sourceAnchors: [],
  };
}

function swimmingFromCss(css: number, sourceAnchors: Anchor[]): SwimmingDerived {
  return {
    available: true,
    cssSecPer100m: round1(css),
    easyPaceSecPer100m: round0(css * 1.18),
    endurancePaceSecPer100m: round0(css * 1.1),
    aerobicPaceSecPer100m: round0(css * 1.08),
    thresholdPaceSecPer100m: round0(css),
    vo2PaceSecPer100m: round0(css * 0.92),
    sprintPaceSecPer100m: round0(css * 0.85),
    sourceAnchors,
  };
}

export function deriveCycling(
  prs: Map<Anchor, PrCandidate>,
  garminFtp?: number | null,
): CyclingDerived {
  // Prefer the FTP Garmin reports directly (from a power meter or auto-detection).
  // Average-power-based PR estimation is only used when Garmin has no FTP for us.
  if (garminFtp != null && garminFtp > 0) {
    return cyclingFromFtp(garminFtp, null);
  }

  const p20 = prs.get('bike:20min');
  const p60 = prs.get('bike:60min');
  let ftp: number | null = null;
  let sourceAnchor: Anchor | null = null;

  // Coggan & Allen, Training and Racing with a Power Meter: FTP is commonly
  // estimated as 95% of 20-minute power, with 60-minute power accepted directly.
  // Formula documented in docs/sports-science-algorithms.md.
  if (p20 && p60) {
    const from20 = p20.value * 0.95;
    const from60 = p60.value;
    ftp = Math.max(from20, from60);
    sourceAnchor = from20 >= from60 ? 'bike:20min' : 'bike:60min';
  } else if (p20) {
    ftp = p20.value * 0.95;
    sourceAnchor = 'bike:20min';
  } else if (p60) {
    ftp = p60.value;
    sourceAnchor = 'bike:60min';
  }

  if (ftp == null) {
    return {
      available: false,
      ftpWatts: null,
      enduranceWatts: null,
      tempoWatts: null,
      thresholdWatts: null,
      vo2Watts: null,
      sourceAnchor: null,
    };
  }

  return cyclingFromFtp(ftp, sourceAnchor);
}

function cyclingFromFtp(ftp: number, sourceAnchor: Anchor | null): CyclingDerived {
  return {
    available: true,
    ftpWatts: Math.round(ftp),
    enduranceWatts: Math.round(ftp * 0.65),
    tempoWatts: Math.round(ftp * 0.85),
    thresholdWatts: Math.round(ftp),
    vo2Watts: Math.round(ftp * 1.1),
    sourceAnchor,
  };
}

function round0(n: number): number {
  return Math.round(n);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
