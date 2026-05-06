import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { user } from '../db/schema.js';

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('usage: tsx src/scripts/promote-admin.ts <email>');
    process.exit(1);
  }
  const updated = await db
    .update(user)
    .set({ role: 'admin', updatedAt: new Date() })
    .where(eq(user.email, email))
    .returning({ id: user.id, email: user.email, role: user.role });
  if (!updated[0]) {
    console.error(`no user found with email ${email}`);
    process.exit(1);
  }
  console.log(`promoted ${updated[0].email} (${updated[0].id}) to admin`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
