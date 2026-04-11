import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { toUserSlug } from "../users.js";
import type { BrowserTarget } from "./types.js";

type BrowserPreferenceMap = Record<string, BrowserTarget>;

function getPreferencesPath(userName: string): string {
  return join(config.usersDir, toUserSlug(userName), ".browser", "preferences.json");
}

export function readBrowserPreferences(userName: string): BrowserPreferenceMap {
  try {
    const path = getPreferencesPath(userName);
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as BrowserPreferenceMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function getPreferredBrowserTarget(userName: string, hostname: string): BrowserTarget | null {
  return readBrowserPreferences(userName)[hostname] || null;
}

export function setPreferredBrowserTarget(userName: string, hostname: string, target: BrowserTarget): void {
  const path = getPreferencesPath(userName);
  const next = { ...readBrowserPreferences(userName), [hostname]: target };
  mkdirSync(join(config.usersDir, toUserSlug(userName), ".browser"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
}
