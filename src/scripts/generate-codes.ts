import 'dotenv/config';
import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { redemptionCode } from '../db/schema.js';

function randomCode(prefix = ''): string {
  const raw = crypto
    .randomBytes(12)
    .toString('base64url')
    .toUpperCase()
    .replace(/[-_]/g, '');
  const body = raw.slice(0, 16).padEnd(16, 'X');
  const grouped = body.match(/.{1,4}/g)!.join('-');
  return prefix ? `${prefix}-${grouped}` : grouped;
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag: string, dflt?: string) => {
    const i = args.indexOf(flag);
    if (i < 0) return dflt;
    return args[i + 1];
  };
  const count = Number(get('--count', '10'));
  const plan = get('--plan', 'max');
  const planDays = Number(get('--days', '30'));
  const prefix = get('--prefix', '');
  const note = get('--note');

  if (!count || !planDays || (plan !== 'pro' && plan !== 'max')) {
    console.error(
      'usage: tsx src/scripts/generate-codes.ts --count 10 --plan max --days 30 [--prefix MAX] [--note "first batch"]',
    );
    process.exit(1);
  }

  const batchId = crypto.randomUUID();
  const codes: string[] = [];
  const seen = new Set<string>();
  while (codes.length < count) {
    const code = randomCode(prefix);
    if (seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  await db.insert(redemptionCode).values(
    codes.map((c) => ({
      code: c,
      plan,
      planDays,
      batchId,
      note: note ?? null,
      createdAt: new Date(),
    })),
  );

  console.log(`batch=${batchId} plan=${plan} planDays=${planDays} count=${count}`);
  for (const c of codes) console.log(c);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
