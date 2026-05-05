import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const PBKDF2_ITERATIONS = 100_000;

export function deriveKey(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha512");
}

export function encrypt(data: string | Buffer, password: string): Buffer {
  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKey(password, salt);
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Format: salt (32) + iv (16) + tag (16) + ciphertext
  return Buffer.concat([salt, iv, tag, encrypted]);
}

export function decrypt(blob: Buffer, password: string): string {
  return decryptBuffer(blob, password).toString("utf-8");
}

export function decryptBuffer(blob: Buffer, password: string): Buffer {
  const salt = blob.subarray(0, SALT_LENGTH);
  const iv = blob.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const tag = blob.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const ciphertext = blob.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

  const key = deriveKey(password, salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// --- Key-based encryption (for keyfile mode) ---

/** Encrypt data using a raw 32-byte key (no password derivation) */
export function encryptWithKey(data: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(data, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Format: iv (16) + tag (16) + ciphertext (no salt — key is already derived)
  return Buffer.concat([iv, tag, encrypted]);
}

/** Decrypt data using a raw 32-byte key */
export function decryptWithKey(blob: Buffer, key: Buffer): string {
  const iv = blob.subarray(0, IV_LENGTH);
  const tag = blob.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
}

/** Generate a random 32-byte keyfile */
export function generateKeyfile(): Buffer {
  return randomBytes(KEY_LENGTH);
}
