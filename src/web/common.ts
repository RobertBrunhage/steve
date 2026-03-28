import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import type { Vault } from "../vault/index.js";
import { isVisibleVaultKey, listVisibleVaultKeys } from "../vault/visible.js";

export const RESERVED_VAULT_KEYS = new Set(["steve/admin_auth", "steve/users"]);
const SETUP_TOKEN_FILE = "setup-token.json";

export interface SetupTokenRecord {
  token: string;
  createdAt: number;
}

export function getOpenCodePorts(): Record<string, number> {
  const portsPath = join(config.dataDir, "opencode-ports.json");
  try {
    if (existsSync(portsPath)) {
      return JSON.parse(readFileSync(portsPath, "utf-8"));
    }
  } catch {}
  return {};
}

export function saveOpenCodePorts(ports: Record<string, number>) {
  writeFileSync(join(config.dataDir, "opencode-ports.json"), JSON.stringify(ports, null, 2), "utf-8");
}

export function parseFields(body: Record<string, string | File>): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < 100; i++) {
    const name = String(body[`field_name_${i}`] || "").trim();
    const value = String(body[`field_value_${i}`] || "").trim();
    if (!name) continue;
    result[name] = value;
  }
  return result;
}

export function getFieldNames(v: Vault): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const key of v.list()) {
    if (!isVisibleVaultKey(key)) continue;
    const val = v.get(key);
    if (val && typeof val === "object") {
      result[key] = Object.keys(val);
    } else if (typeof val === "string") {
      result[key] = [key.split("/").pop() || "value"];
    }
  }
  return result;
}

export function valueToFields(key: string, val: Record<string, unknown> | string | null): [string, string][] {
  if (typeof val === "string") {
    return [[key.split("/").pop() || "value", ""]];
  }
  if (!val || typeof val !== "object") return [["", ""]];
  return Object.entries(val).map(([k]) => [k, ""]);
}

export function applyFieldsToVaultValue(existingValue: Record<string, unknown> | string | null, fields: Record<string, string>): Record<string, string> | string {
  if (typeof existingValue === "string") {
    const firstValue = Object.values(fields)[0];
    return firstValue || existingValue;
  }
  return fields;
}

export function mergeFieldsWithExistingValue(existingValue: Record<string, unknown> | string | null, fields: Record<string, string>): Record<string, string> | string {
  if (typeof existingValue === "string") {
    const firstValue = Object.values(fields)[0];
    return firstValue || existingValue;
  }

  const existingRecord = existingValue && typeof existingValue === "object"
    ? Object.fromEntries(Object.entries(existingValue).map(([key, value]) => [key, String(value)]))
    : {};

  const nextRecord: Record<string, string> = {};
  for (const [field, submittedValue] of Object.entries(fields)) {
    if (submittedValue) {
      nextRecord[field] = submittedValue;
      continue;
    }
    if (field in existingRecord) {
      nextRecord[field] = existingRecord[field];
    }
  }

  return nextRecord;
}

export function getVisibleVaultKeys(vault: Vault | null): string[] {
  return listVisibleVaultKeys(vault);
}

function setupTokenPath(): string {
  return join(config.dataDir, SETUP_TOKEN_FILE);
}

export function readSetupToken(): SetupTokenRecord | null {
  try {
    if (!existsSync(setupTokenPath())) return null;
    const data = JSON.parse(readFileSync(setupTokenPath(), "utf-8")) as Partial<SetupTokenRecord>;
    if (typeof data.token !== "string" || !data.token) return null;
    if (typeof data.createdAt !== "number") return null;
    return { token: data.token, createdAt: data.createdAt };
  } catch {
    return null;
  }
}

export function writeSetupToken(record: SetupTokenRecord): void {
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(setupTokenPath(), JSON.stringify(record, null, 2), "utf-8");
}

export function clearSetupToken(): void {
  rmSync(setupTokenPath(), { force: true });
}
