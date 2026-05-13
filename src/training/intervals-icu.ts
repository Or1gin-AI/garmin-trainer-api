import type { Workout } from '../db/schema.js';

const NA = '不适用';

type WorkoutVars = Record<string, string | number | boolean | null | undefined>;

export function renderIntervalsIcu(workouts: Workout[]): string {
  return workouts
    .filter((w) => w.sport !== 'rest' && w.sport !== 'mobility')
    .map(renderWorkout)
    .join('\n\n');
}

function renderWorkout(w: Workout): string {
  const session = w.sessionLabel ? ` ${w.sessionLabel}` : '';
  const header = [
    `# ${String(w.date)} D${w.dayIndex}.${w.slotIndex ?? 1}${session}`,
    `# ${sportLabel(w.sport)} - ${w.title}`,
  ];
  return [...header, ...renderGroups(w)].join('\n');
}

function renderGroups(w: Workout): string[] {
  if (w.sport === 'running') return renderRun(w);
  if (w.sport === 'cycling') return renderBike(w);
  if (w.sport === 'swimming') return renderSwim(w);
  return renderGeneric(w);
}

function renderRun(w: Workout): string[] {
  const type = w.workoutType ?? '';
  const warmup = minutes(w, ['warmupDuration'], 10);
  const cooldown = minutes(w, ['cooldownDuration'], 10);
  const total = w.durationMinutes ?? warmup + cooldown + 20;

  if (type === 'recovery') {
    return section('Main Set', [`- ${Math.max(total, 20)}m Z1 HR`]);
  }
  if (type === 'aerobic' || type === 'lsd') {
    return [
      ...section('Main Set', [`- ${Math.max(total, 30)}m Z2 HR`]),
    ];
  }
  if (type === 'tempo') {
    const reps = repsValue(w, ['tempoRepeats'], 1);
    const work = minutes(w, ['tempoDuration'], Math.max(12, Math.round((total - warmup - cooldown) / reps)));
    const rest = minutes(w, ['recoveryDuration'], 3);
    return withWarmCool(w, [
      `Main Set ${reps}x`,
      `- ${work}m ${paceTarget(w, '90% Pace', true)}`,
      ...(reps > 1 ? [`- ${rest}m Z1 HR`] : []),
    ]);
  }
  if (type === 'threshold' || type === 'double_threshold') {
    const reps = repsValue(w, ['thresholdRepeats'], type === 'double_threshold' ? 5 : 3);
    const workDistance = num(w, ['thresholdDistance'], null);
    const work = workDistance ? `${workDistance}km` : `${minutes(w, ['thresholdDuration'], 8)}m`;
    const rest = minutes(w, ['recoveryDuration'], 1);
    return withWarmCool(w, [
      `Main Set ${reps}x`,
      `- ${work} ${type === 'threshold' ? 'Z4 HR' : paceTarget(w, '100% Pace', true)}`,
      `- ${rest}m Z1 HR`,
    ]);
  }
  if (type === 'interval') {
    const reps = repsValue(w, ['intervalRepeats'], 6);
    const distance = meters(w, ['intervalDistance'], 800);
    const recovery = meters(w, ['recoveryDistance'], 400);
    return withWarmCool(w, [
      `Main Set ${reps}x`,
      `- ${distance}mtr ${paceTarget(w, '108% Pace', true)}`,
      `- ${recovery}mtr Z1 HR`,
    ]);
  }
  if (type === 'vo2max') {
    const reps = repsValue(w, ['vo2Repeats'], 5);
    const work = minutes(w, ['vo2Duration'], 4);
    const rest = minutes(w, ['recoveryDuration'], 3);
    return withWarmCool(w, [
      `Main Set ${reps}x`,
      `- ${work}m ${paceTarget(w, '100% Pace', true)}`,
      `- ${rest}m Z1 HR`,
    ]);
  }
  if (type === 'hill') {
    const reps = repsValue(w, ['hillRepeats'], 8);
    const seconds = secondsValue(w, ['hillDurationSeconds'], 20);
    const recovery = secondsValue(w, ['recoverySeconds'], 90);
    return withWarmCool(w, [
      `Main Set ${reps}x`,
      `- ${seconds}s 110% Pace`,
      `- ${recovery}s Z1 HR`,
    ]);
  }
  if (type === 'strides') {
    const reps = repsValue(w, ['strideRepeats'], 8);
    const seconds = secondsValue(w, ['strideDurationSeconds'], 20);
    return withWarmCool(w, [
      `Strides ${reps}x`,
      `- ${seconds}s 110% Pace`,
      '- 60s Z1 HR',
    ]);
  }
  if (type === 'progression') {
    const main = Math.max(total - warmup - cooldown, 20);
    return withWarmCool(w, [
      'Main Set',
      `- ${Math.round(main * 0.5)}m Z2 HR`,
      `- ${Math.round(main * 0.5)}m 90-100% Pace`,
    ]);
  }
  if (type === 'race_pace') {
    return withWarmCool(w, [
      'Main Set',
      `- ${Math.max(total - warmup - cooldown, 20)}m ${paceTarget(w, '100% Pace', true)}`,
    ]);
  }
  return renderGeneric(w);
}

function renderBike(w: Workout): string[] {
  const type = w.workoutType ?? '';
  const total = w.durationMinutes ?? 60;

  if (type === 'recovery_spin') return section('Main Set', [`- ${total}m 50-60%`]);
  if (type === 'endurance' || type === 'long_ride') return section('Main Set', [`- ${total}m 65-75%`]);
  if (type === 'cadence_drill') {
    return withWarmCool(w, [
      'Main Set 6x',
      '- 2m 90% 100rpm',
      '- 2m 60%',
    ]);
  }

  const presets: Record<string, { reps: string[]; duration: string[]; fallbackReps: number; fallbackDuration: number; target: string; rest?: number }> = {
    tempo: { reps: ['tempoRepeats'], duration: ['tempoDuration'], fallbackReps: 3, fallbackDuration: 12, target: '76-87%', rest: 5 },
    sweet_spot: { reps: ['sweetSpotRepeats'], duration: ['sweetSpotDuration'], fallbackReps: 3, fallbackDuration: 12, target: '88-94%', rest: 5 },
    threshold: { reps: ['thresholdRepeats'], duration: ['thresholdDuration'], fallbackReps: 2, fallbackDuration: 20, target: '95-100%', rest: 8 },
    vo2max: { reps: ['vo2Repeats'], duration: ['vo2Duration'], fallbackReps: 5, fallbackDuration: 4, target: '110-120%', rest: 4 },
    anaerobic: { reps: ['anaerobicRepeats'], duration: ['anaerobicDuration'], fallbackReps: 8, fallbackDuration: 1, target: '120-140%', rest: 3 },
    climb: { reps: ['climbRepeats'], duration: ['climbDuration'], fallbackReps: 4, fallbackDuration: 8, target: '80-95%', rest: 5 },
  };
  const preset = presets[type];
  if (preset) {
    const reps = repsValue(w, preset.reps, preset.fallbackReps);
    const work = minutes(w, preset.duration, preset.fallbackDuration);
    const rest = minutes(w, ['recoveryDuration'], preset.rest ?? 4);
    return withWarmCool(w, [
      `Main Set ${reps}x`,
      `- ${work}m ${powerTarget(w, preset.target)}`,
      `- ${rest}m 50-60%`,
    ]);
  }

  if (type === 'sprint') {
    const reps = repsValue(w, ['sprintRepeats'], 8);
    const seconds = secondsValue(w, ['sprintDurationSeconds'], 15);
    const rest = minutes(w, ['sprintRecoveryMinutes'], 4);
    return withWarmCool(w, [
      `Main Set ${reps}x`,
      `- ${seconds}s MAX`,
      `- ${rest}m 50%`,
    ]);
  }

  if (type === 'over_under') {
    const reps = repsValue(w, ['blockRepeats'], 3);
    const rest = minutes(w, ['recoveryDuration'], 6);
    return withWarmCool(w, [
      `Main Set ${reps}x`,
      '- 2m 95%',
      '- 1m 105%',
      '- 2m 95%',
      '- 1m 105%',
      '- 2m 95%',
      '- 1m 105%',
      `- ${rest}m 55%`,
    ]);
  }

  return renderGeneric(w);
}

function renderSwim(w: Workout): string[] {
  const type = w.workoutType ?? '';
  const warmup = meters(w, ['warmupMeters'], 300);
  const cooldown = meters(w, ['cooldownMeters'], 200);

  if (type === 'recovery' || type === 'technique' || type === 'aerobic') {
    const distanceKm = Number(w.distanceKm ?? 1.5);
    const main = meters(w, ['mainTotalMeters'], Math.max(400, Math.round((distanceKm * 1000) - warmup - cooldown)));
    return [
      ...section('Warmup', [`- ${warmup}mtr Easy`]),
      ...section('Main Set', [`- ${main}mtr ${type === 'technique' ? 'Drill' : paceTarget(w, '85-90% Pace')}`]),
      ...section('Cooldown', [`- ${cooldown}mtr Easy`]),
    ];
  }

  const preset = swimPreset(type);
  if (preset) {
    const reps = repsValue(w, preset.reps, preset.fallbackReps);
    const distance = meters(w, preset.distance, preset.fallbackDistance);
    const rest = secondsValue(w, preset.rest, preset.fallbackRest);
    const lines = [
      ...section('Warmup', [`- ${warmup}mtr Easy`]),
      `Main Set ${reps}x`,
      `- ${distance}mtr ${preset.target}`,
      `- ${rest}s Rest`,
    ];
    if (type === 'kick') {
      lines.push('', 'Auxiliary 6x', '- 100mtr Easy', '- 20s Rest');
    }
    lines.push('', 'Cooldown', `- ${cooldown}mtr Easy`);
    return lines;
  }

  return renderGeneric(w);
}

function swimPreset(type: string): {
  reps: string[];
  distance: string[];
  rest: string[];
  fallbackReps: number;
  fallbackDistance: number;
  fallbackRest: number;
  target: string;
} | null {
  if (type === 'endurance') {
    return { reps: ['enduranceRepeats'], distance: ['enduranceDistance'], rest: ['restSeconds'], fallbackReps: 3, fallbackDistance: 600, fallbackRest: 60, target: '90-95% Pace' };
  }
  if (type === 'css_threshold') {
    return { reps: ['cssRepeats'], distance: ['cssDistance'], rest: ['restSeconds'], fallbackReps: 8, fallbackDistance: 100, fallbackRest: 20, target: '100% Pace' };
  }
  if (type === 'vo2max') {
    return { reps: ['vo2Repeats'], distance: ['vo2Distance'], rest: ['restSeconds'], fallbackReps: 12, fallbackDistance: 100, fallbackRest: 35, target: '105-115% Pace' };
  }
  if (type === 'sprint') {
    return { reps: ['sprintRepeats'], distance: ['sprintDistance'], rest: ['sprintRestSeconds'], fallbackReps: 12, fallbackDistance: 25, fallbackRest: 40, target: 'MAX' };
  }
  if (type === 'pull') {
    return { reps: ['pullRepeats'], distance: ['pullDistance'], rest: ['restSeconds'], fallbackReps: 8, fallbackDistance: 100, fallbackRest: 25, target: '90-100% Pace Pull' };
  }
  if (type === 'kick') {
    return { reps: ['kickRepeats'], distance: ['kickDistance'], rest: ['kickRestSeconds'], fallbackReps: 8, fallbackDistance: 50, fallbackRest: 30, target: 'Kick' };
  }
  if (type === 'open_water') {
    return { reps: ['openWaterRepeats'], distance: ['openWaterDistance'], rest: ['restSeconds'], fallbackReps: 3, fallbackDistance: 500, fallbackRest: 45, target: '90-95% Pace' };
  }
  return null;
}

function renderGeneric(w: Workout): string[] {
  const duration = w.durationMinutes ? `${w.durationMinutes}m` : w.distanceKm ? `${Math.round(Number(w.distanceKm) * 1000)}mtr` : '30m';
  const target =
    w.sport === 'cycling'
      ? powerTarget(w, '65-75%')
      : w.sport === 'running'
        ? hrOrPaceTarget(w)
        : paceTarget(w, 'Easy');
  return section('Main Set', [`- ${duration} ${target}`]);
}

function withWarmCool(w: Workout, mainLines: string[]): string[] {
  const warmup = minutes(w, ['warmupDuration'], 15);
  const cooldown = minutes(w, ['cooldownDuration'], 10);
  return [
    ...section('Warmup', [`- ${warmup}m ${w.sport === 'cycling' ? '55%' : 'Z2 HR'}`]),
    '',
    ...mainLines,
    '',
    ...section('Cooldown', [`- ${cooldown}m ${w.sport === 'cycling' ? '50%' : 'Z1 HR'}`]),
  ];
}

function section(title: string, lines: string[]): string[] {
  return [title, ...lines];
}

function variables(w: Workout): WorkoutVars {
  const source = w.parameterSource as { replacedVariables?: WorkoutVars } | null;
  return source?.replacedVariables && typeof source.replacedVariables === 'object'
    ? source.replacedVariables
    : {};
}

function num(w: Workout, names: string[], fallback: number | null): number | null {
  const vars = variables(w);
  for (const name of names) {
    const raw = vars[name];
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function repsValue(w: Workout, names: string[], fallback: number): number {
  return Math.max(1, Math.round(num(w, names, fallback) ?? fallback));
}

function minutes(w: Workout, names: string[], fallback: number): number {
  return Math.max(1, Math.round(num(w, names, fallback) ?? fallback));
}

function secondsValue(w: Workout, names: string[], fallback: number): number {
  return Math.max(5, Math.round(num(w, names, fallback) ?? fallback));
}

function meters(w: Workout, names: string[], fallback: number): number {
  return Math.max(25, Math.round(num(w, names, fallback) ?? fallback));
}

function usable(value: string | null | undefined): string | null {
  if (!value || value === NA) return null;
  return value.trim();
}

function paceTarget(w: Workout, fallback: string, preferFallback = false): string {
  if (preferFallback && fallback.includes('%')) return fallback;
  const pace = usable(w.targetPace);
  if (!pace) return fallback;
  const match = pace.match(/\d+:\d{2}(?:\s*-\s*\d+:\d{2})?\/(?:km|100m)/);
  if (!match) return fallback;
  return `${match[0].replace(/\s+/g, '')} Pace`;
}

function powerTarget(w: Workout, fallback: string): string {
  const power = usable(w.targetPower);
  if (!power) return fallback;
  const pct = power.match(/\d+(?:\.\d+)?\s*(?:-|to|~)\s*\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*%/i);
  if (pct) return pct[0].replace(/\s+/g, '').replace(/to/i, '-');
  const watts = power.match(/\d+\s*(?:-|to|~)\s*\d+\s*w|\d+\s*w/i);
  if (watts) return watts[0].replace(/\s+/g, '').replace(/to/i, '-').toLowerCase();
  return fallback;
}

function hrOrPaceTarget(w: Workout): string {
  if (w.targetMetric === 'pace') return paceTarget(w, '90% Pace');
  const type = w.workoutType ?? '';
  if (type === 'threshold' || type === 'double_threshold') return 'Z4 HR';
  if (type === 'tempo') return 'Z3-Z4 HR';
  if (type === 'recovery') return 'Z1 HR';
  return 'Z2 HR';
}

function sportLabel(sport: string): string {
  if (sport === 'running') return 'Run';
  if (sport === 'cycling') return 'Ride';
  if (sport === 'swimming') return 'Swim';
  return sport;
}
