import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { garminAccount } from '../db/schema.js';
import { encryptForUser, decryptForUser } from '../lib/crypto.js';

export type Region = 'cn' | 'global';

export interface DecryptedGarminAccount {
  username: string;
  password: string;
  session: { oauth1?: unknown; oauth2?: unknown } | null;
  profile: { fullName?: string; userName?: string; location?: string } | null;
  lastValidatedAt: Date | null;
}

export async function loadGarminAccount(
  userId: string,
  region: Region,
): Promise<DecryptedGarminAccount | null> {
  const rows = await db
    .select()
    .from(garminAccount)
    .where(and(eq(garminAccount.userId, userId), eq(garminAccount.region, region)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const sessionPlain = decryptForUser(userId, row.sessionEnc);
  return {
    username: decryptForUser(userId, row.usernameEnc),
    password: decryptForUser(userId, row.passwordEnc),
    session: sessionPlain
      ? (safeJson(sessionPlain) as { oauth1?: unknown; oauth2?: unknown } | null)
      : null,
    profile: row.profile ?? null,
    lastValidatedAt: row.lastValidatedAt,
  };
}

export async function upsertGarminAccount(
  userId: string,
  region: Region,
  data: { username: string; password: string },
): Promise<void> {
  const id = `${userId}:${region}`;
  const usernameEnc = encryptForUser(userId, data.username);
  const passwordEnc = encryptForUser(userId, data.password);
  const now = new Date();

  await db
    .insert(garminAccount)
    .values({
      id,
      userId,
      region,
      usernameEnc,
      passwordEnc,
      sessionEnc: null,
      profile: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: garminAccount.id,
      set: { usernameEnc, passwordEnc, updatedAt: now },
    });
}

export async function persistGarminSession(
  userId: string,
  region: Region,
  token: unknown,
  profile: { fullName?: string; userName?: string; location?: string } | null,
): Promise<void> {
  const id = `${userId}:${region}`;
  const sessionEnc = token ? encryptForUser(userId, JSON.stringify(token)) : null;
  await db
    .update(garminAccount)
    .set({
      sessionEnc,
      profile,
      lastValidatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(garminAccount.id, id));
}

export async function clearGarminSession(
  userId: string,
  region: Region,
): Promise<void> {
  const id = `${userId}:${region}`;
  await db
    .update(garminAccount)
    .set({ sessionEnc: null, updatedAt: new Date() })
    .where(eq(garminAccount.id, id));
}

export async function deleteGarminAccount(
  userId: string,
  region: Region,
): Promise<void> {
  const id = `${userId}:${region}`;
  await db.delete(garminAccount).where(eq(garminAccount.id, id));
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
