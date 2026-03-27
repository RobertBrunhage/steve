import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import type { Vault } from "../vault/index.js";
import { ADMIN_AUTH_KEY } from "./auth.js";

export const RESERVED_VAULT_KEYS = new Set([ADMIN_AUTH_KEY, "telegram/bot_token", "steve/users"]);
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
    if (RESERVED_VAULT_KEYS.has(key)) continue;
    const val = v.get(key);
    if (val && typeof val === "object") {
      result[key] = Object.keys(val);
    }
  }
  return result;
}

export function valueToFields(val: Record<string, unknown> | null): [string, string][] {
  if (!val || typeof val !== "object") return [["", ""]];
  return Object.entries(val).map(([k, v]) => [k, String(v)]);
}

export function getVisibleVaultKeys(vault: Vault | null): string[] {
  return (vault?.list() ?? []).filter((key) => !RESERVED_VAULT_KEYS.has(key));
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
