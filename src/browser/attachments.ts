import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { toUserSlug } from "../users.js";
import type { AttachedBrowserConfig, ChromeChannel } from "./types.js";

const ATTACHMENT_FILE = "attached-browser.json";

function getAttachmentPath(userName: string): string {
  return join(config.usersDir, toUserSlug(userName), ".browser", ATTACHMENT_FILE);
}

export function readAttachedBrowserConfig(userName: string): AttachedBrowserConfig | null {
  try {
    const path = getAttachmentPath(userName);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<AttachedBrowserConfig>;
    if (!parsed || parsed.mode !== "local_chrome") return null;
    const channel = parsed.channel === "beta" || parsed.channel === "dev" || parsed.channel === "canary"
      ? parsed.channel
      : "stable";
    return {
      mode: "local_chrome",
      channel,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      lastConnectedAt: typeof parsed.lastConnectedAt === "string" ? parsed.lastConnectedAt : null,
      lastError: typeof parsed.lastError === "string" ? parsed.lastError : null,
    };
  } catch {
    return null;
  }
}

export function writeAttachedBrowserConfig(userName: string, input: { channel?: ChromeChannel }): AttachedBrowserConfig {
  const current = readAttachedBrowserConfig(userName);
  const next: AttachedBrowserConfig = {
    mode: "local_chrome",
    channel: input.channel || current?.channel || "stable",
    updatedAt: new Date().toISOString(),
    lastConnectedAt: current?.lastConnectedAt || null,
    lastError: current?.lastError || null,
  };
  const path = getAttachmentPath(userName);
  mkdirSync(join(config.usersDir, toUserSlug(userName), ".browser"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return next;
}

export function updateAttachedBrowserConfig(userName: string, updates: Partial<AttachedBrowserConfig>): AttachedBrowserConfig | null {
  const current = readAttachedBrowserConfig(userName);
  if (!current) return null;
  const next: AttachedBrowserConfig = {
    ...current,
    ...updates,
    mode: "local_chrome",
    channel: updates.channel || current.channel,
    updatedAt: current.updatedAt,
  };
  const path = getAttachmentPath(userName);
  mkdirSync(join(config.usersDir, toUserSlug(userName), ".browser"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return next;
}

export function clearAttachedBrowserConfig(userName: string): void {
  rmSync(getAttachmentPath(userName), { force: true });
}

export function hasAttachedBrowser(userName: string): boolean {
  return readAttachedBrowserConfig(userName) !== null;
}
