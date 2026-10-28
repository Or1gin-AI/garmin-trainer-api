// Shared "not applicable" sentinel for workout target fields
// (targetHeartRate / targetPace / targetPower).
//
// New plans are generated with the English `N/A`. Plans persisted before the
// English switch still carry the legacy Chinese sentinel, so every reader must
// go through `isNotApplicable` instead of comparing against a literal.
export const NOT_APPLICABLE = 'N/A';

const LEGACY_NOT_APPLICABLE = '不适用';

export function isNotApplicable(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  const trimmed = value.trim();
  if (trimmed === '') return true;
  return (
    trimmed === NOT_APPLICABLE ||
    trimmed.toUpperCase() === 'N/A' ||
    trimmed === LEGACY_NOT_APPLICABLE
  );
}

// Strict variant: true only for the sentinel itself (new or legacy), not for
// empty / missing values. Used by validation, which must still flag blanks.
export function isNotApplicableSentinel(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.toUpperCase() === NOT_APPLICABLE || trimmed === LEGACY_NOT_APPLICABLE;
}

// True when a free-text target line mentions the sentinel (e.g. "Total duration N/A").
export function mentionsNotApplicable(text: string): boolean {
  return text.includes(NOT_APPLICABLE) || text.includes(LEGACY_NOT_APPLICABLE);
}
