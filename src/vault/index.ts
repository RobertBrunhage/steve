import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { encrypt, decrypt, encryptWithKey, decryptWithKey, generateKeyfile } from "./crypto.js";

const KEYFILE_NAME = "keyfile";
const KEYFILE_ENC_NAME = "keyfile.enc";
const SECRETS_NAME = "secrets.enc";

export class Vault {
  private data: Record<string, Record<string, unknown>> = {};
  private key: Buffer;
  private filePath: string;

  constructor(vaultDir: string, key: Buffer) {
    this.filePath = join(vaultDir, SECRETS_NAME);
    this.key = key;
    this.load();
  }

  private load() {
    if (!existsSync(this.filePath)) {
      this.data = {};
      return;
    }
    const blob = readFileSync(this.filePath);
    const json = decryptWithKey(blob, this.key);
    this.data = JSON.parse(json);
  }

  private save() {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const blob = encryptWithKey(JSON.stringify(this.data), this.key);
    writeFileSync(this.filePath, blob);
  }

  get(key: string): Record<string, unknown> | null {
    return this.data[key] ?? null;
  }

  getString(key: string): string | null {
    const val = this.data[key];
    if (val === undefined || val === null) return null;
    if (typeof val === "string") return val;
    return JSON.stringify(val);
  }

  set(key: string, value: Record<string, unknown> | string): void {
    this.data[key] = value as Record<string, unknown>;
    this.save();
  }

  has(key: string): boolean {
    return key in this.data;
  }

  delete(key: string): void {
    delete this.data[key];
    this.save();
  }

  list(): string[] {
    return Object.keys(this.data);
  }

  getByPrefix(prefix: string): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {};
    for (const [key, value] of Object.entries(this.data)) {
      if (key.toLowerCase().startsWith(prefix.toLowerCase())) {
        result[key] = value;
      }
    }
    return result;
  }
}

/** Initialize vault directory: create keyfile if it doesn't exist */
export function initializeVault(vaultDir: string, password: string): Buffer {
  mkdirSync(vaultDir, { recursive: true });

  const keyfilePath = join(vaultDir, KEYFILE_NAME);
  const keyfileEncPath = join(vaultDir, KEYFILE_ENC_NAME);

  if (existsSync(keyfilePath)) {
    // Keyfile already exists — read it
    return readFileSync(keyfilePath);
  }

  // Generate new keyfile
  const keyfile = generateKeyfile();

  // Store raw keyfile (for daily auto-start)
  writeFileSync(keyfilePath, keyfile);

  // Store password-encrypted backup of keyfile (for backup/restore)
  const encryptedKeyfile = encrypt(keyfile.toString("base64"), password);
  writeFileSync(keyfileEncPath, encryptedKeyfile);

  return keyfile;
}

/** Read the keyfile from vault directory (no password needed) */
export function readKeyfile(vaultDir: string): Buffer | null {
  const keyfilePath = join(vaultDir, KEYFILE_NAME);
  if (!existsSync(keyfilePath)) return null;
  return readFileSync(keyfilePath);
}

/** Recover keyfile from encrypted backup using password */
export function recoverKeyfile(vaultDir: string, password: string): Buffer {
  const keyfileEncPath = join(vaultDir, KEYFILE_ENC_NAME);
  if (!existsSync(keyfileEncPath)) {
    throw new Error("No encrypted keyfile backup found");
  }
  const blob = readFileSync(keyfileEncPath);
  const base64 = decrypt(blob, password);
  return Buffer.from(base64, "base64");
}

/** Check if vault is initialized with a keyfile */
export function hasKeyfile(vaultDir: string): boolean {
  return existsSync(join(vaultDir, KEYFILE_NAME));
}
