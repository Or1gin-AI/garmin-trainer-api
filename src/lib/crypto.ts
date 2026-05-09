import crypto from 'node:crypto';

/**
 * AES-256-GCM with per-user key derivation.
 *
 *   key = HKDF(SHA-256, master = APP_ENCRYPTION_KEY, salt = `user:${userId}`, info = 'garmin-trainer/v1')
 *
 * Rotating APP_ENCRYPTION_KEY invalidates every stored secret across all users.
 */

const INFO = Buffer.from('garmin-trainer/v1');

function getMasterMaterial(): string {
  const value = process.env.APP_ENCRYPTION_KEY?.trim();
  if (!value) {
    throw new Error('APP_ENCRYPTION_KEY is not configured');
  }
  return value;
}

const keyCache = new Map<string, Buffer>();

function deriveKey(userId: string): Buffer {
  const cached = keyCache.get(userId);
  if (cached) return cached;
  const master = Buffer.from(getMasterMaterial(), 'utf8');
  const salt = Buffer.from(`user:${userId}`, 'utf8');
  const key = Buffer.from(
    crypto.hkdfSync('sha256', master, salt, INFO, 32) as ArrayBuffer,
  );
  keyCache.set(userId, key);
  return key;
}

export function encryptForUser(userId: string, plaintext: string): string {
  if (!plaintext) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(userId), iv);
  const enc = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString('base64'),
    tag.toString('base64'),
    enc.toString('base64'),
  ].join('.');
}

export function decryptForUser(
  userId: string,
  payload: string | null | undefined,
): string {
  if (!payload) return '';
  const [ivText, tagText, encText] = payload.split('.');
  if (!ivText || !tagText || !encText) return '';
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    deriveKey(userId),
    Buffer.from(ivText, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(encText, 'base64')),
    decipher.final(),
  ]);
  return dec.toString('utf8');
}

/**
 * Global key derived from APP_ENCRYPTION_KEY directly (no user salt).
 * sha256 ensures we get exactly 32 bytes whatever length the env var is.
 * Cached after first compute.
 */
let globalKey: Buffer | null = null;

function getGlobalKey(): Buffer {
  if (globalKey) return globalKey;
  globalKey = crypto.createHash('sha256').update(getMasterMaterial(), 'utf8').digest();
  return globalKey;
}

/**
 * Encrypts a string with the master key (no per-user salt).
 * Output format matches encryptForUser: "iv.tag.cipher" with each segment base64.
 * Use case: admin-managed secrets like LLM provider API keys.
 */
export function encryptGlobal(plaintext: string): string {
  if (!plaintext) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getGlobalKey(), iv);
  const enc = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString('base64'),
    tag.toString('base64'),
    enc.toString('base64'),
  ].join('.');
}

/**
 * Decrypts a payload produced by encryptGlobal. Throws on tampering / bad input.
 */
export function decryptGlobal(payload: string | null | undefined): string {
  if (!payload) return '';
  const [ivText, tagText, encText] = payload.split('.');
  if (!ivText || !tagText || !encText) {
    throw new Error('decryptGlobal: malformed payload');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getGlobalKey(),
    Buffer.from(ivText, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(encText, 'base64')),
    decipher.final(),
  ]);
  return dec.toString('utf8');
}
