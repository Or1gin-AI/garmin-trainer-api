import 'dotenv/config';
import { updateUserProfile } from '../training/profile/update.js';

async function main() {
  const userId = process.argv[2];
  if (!userId) {
    console.error('usage: tsx src/scripts/recompute-profile.ts <userId>');
    process.exit(1);
  }
  await updateUserProfile(userId);
  console.log(`recomputed profile for ${userId}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
