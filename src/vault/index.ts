import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { encrypt, decrypt } from "./crypto.js";

export class Vault {
  private data: Record<string, Record<string, unknown>> = {};
  private password: string;
  private filePath: string;

  constructor(filePath: string, password: string) {
    this.filePath = filePath;
    this.password = password;
    this.load();
  }

  private load() {
    if (!existsSync(this.filePath)) {
      this.data = {};
      return;
    }
    const blob = readFileSync(this.filePath);
    const json = decrypt(blob, this.password);
    this.data = JSON.parse(json);
  }

  private save() {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const blob = encrypt(JSON.stringify(this.data), this.password);
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

  /** Get all keys matching a prefix */
  getByPrefix(prefix: string): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {};
    for (const [key, value] of Object.entries(this.data)) {
      if (key.toLowerCase().startsWith(prefix.toLowerCase())) {
        result[key] = value;
      }
    }
    return result;
  }

  exists(): boolean {
    return existsSync(this.filePath);
  }
}
