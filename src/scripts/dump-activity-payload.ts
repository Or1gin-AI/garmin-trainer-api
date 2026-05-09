import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { activityCache } from '../db/schema.js';
import {
  ACTIVITY_FIELD_ALIASES,
  pickFirst,
  type ActivityAliasKey,
} from '../garmin/utils.js';

/**
 * Read-only admin probe for verifying which Garmin field paths actually
 * carry values in real activity payloads. Use this when extending
 * mapActivity() with new alias paths to confirm the SDK exposes them.
 *
 * Usage: pnpm tsx src/scripts/dump-activity-payload.ts <activityId>
 */
async function main() {
  const activityId = process.argv[2];
  if (!activityId) {
    console.error('usage: tsx src/scripts/dump-activity-payload.ts <activityId>');
    process.exit(1);
  }

  const rows = await db
    .select()
    .from(activityCache)
    .where(eq(activityCache.activityId, activityId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    console.error(`no activity_cache row found for activityId ${activityId}`);
    process.exit(1);
  }

  console.log('=== activity_cache row ===');
  console.log(`id:          ${row.id}`);
  console.log(`userId:      ${row.userId}`);
  console.log(`region:      ${row.region}`);
  console.log(`activityId:  ${row.activityId}`);
  console.log(`fetchedAt:   ${row.fetchedAt.toISOString()}`);
  console.log('');
  console.log('=== raw .data jsonb ===');
  console.log(JSON.stringify(row.data, null, 2));
  console.log('');

  console.log('=== Field availability report ===');
  const raw = row.data;
  const keys = Object.keys(ACTIVITY_FIELD_ALIASES) as ActivityAliasKey[];
  const colWidth = Math.max(...keys.map((k) => k.length));

  for (const key of keys) {
    const aliases = ACTIVITY_FIELD_ALIASES[key];
    let resolvedAlias: string | undefined;
    let resolvedValue: unknown;
    for (const alias of aliases) {
      const v = pickFirst(raw, [alias]);
      if (v !== undefined) {
        resolvedAlias = alias;
        resolvedValue = v;
        break;
      }
    }
    const label = key.padEnd(colWidth);
    if (resolvedAlias !== undefined) {
      const display =
        typeof resolvedValue === 'object'
          ? JSON.stringify(resolvedValue)
          : String(resolvedValue);
      console.log(`  ${label}  OK   from ${resolvedAlias} -> ${display}`);
    } else {
      console.log(
        `  ${label}  MISS none of [${aliases.join(', ')}] yielded a value`,
      );
    }
  }

  // Note about fields not in ACTIVITY_FIELD_ALIASES.
  const summaryDTO =
    raw !== null && typeof raw === 'object'
      ? (raw as Record<string, unknown>).summaryDTO
      : undefined;
  console.log('');
  console.log('=== Special fields (not alias-resolved) ===');
  console.log(`  source              hardcoded -> 'garmin'`);
  console.log(
    `  rawTrainingSummary  ${summaryDTO === undefined ? 'MISS summaryDTO absent' : 'OK   summaryDTO present (full nested object preserved)'}`,
  );

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
