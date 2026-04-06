import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Vault } from "./vault/index.js";
import { getTelegramBotToken } from "./secrets.js";
import { getAllowedTelegramIds, normalizeUsers, toUserSlug, type UsersMap } from "./users.js";
import type { BrowserSettings } from "./browser/types.js";


const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const steveDir = process.env.STEVE_DIR || join(homedir(), ".steve");
const stateDir = process.env.STEVE_STATE_DIR || steveDir;

const vaultDir = process.env.STEVE_VAULT_DIR || "/vault";
const mcpPort = Number(process.env.STEVE_MCP_PORT) || 3100;
const webPort = Number(process.env.STEVE_WEB_PORT) || 7838;
const opencodePortBase = Number(process.env.STEVE_OPENCODE_PORT_BASE) || 3456;
const browserViewerPortBase = Number(process.env.STEVE_BROWSER_VIEWER_PORT_BASE) || 6080;
const browserViewerPortMax = Number(process.env.STEVE_BROWSER_VIEWER_PORT_MAX) || 6119;
const browserVncPortBase = Number(process.env.STEVE_BROWSER_VNC_PORT_BASE) || 5901;
const browserDisplayBase = Number(process.env.STEVE_BROWSER_DISPLAY_BASE) || 90;
const remoteBrowserBaseUrl = process.env.STEVE_REMOTE_BROWSER_URL || "";
const telegramApiBase = process.env.STEVE_TELEGRAM_API_BASE || "https://api.telegram.org";
const DEFAULT_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  enabled: true,
  defaultTarget: "container",
  artifactsRetentionDays: 14,
  remoteEnabled: !!remoteBrowserBaseUrl,
  remoteBaseUrl: remoteBrowserBaseUrl,
};

export interface SteveSystemSettings {
  timezone: string;
  browser: BrowserSettings;
}

export interface SteveConfig {
  projectRoot: string;
  steveDir: string;
  stateDir: string;
  dataDir: string;
  usersDir: string;
  sharedDir: string;
  defaultsDir: string;
  defaultSkillsDir: string;
  vaultDir: string;
  mcpPort: number;
  webPort: number;
  opencodePortBase: number;
  browserViewerPortBase: number;
  browserViewerPortMax: number;
  browserVncPortBase: number;
  browserDisplayBase: number;
  telegramApiBase: string;
}

/** Get the workspace directory for a specific user */
export function getUserDir(userName: string): string {
  return join(config.usersDir, toUserSlug(userName));
}

/** Get the skills directory for a specific user */
export function getUserSkillsDir(userName: string): string {
  return join(getUserDir(userName), "skills");
}

/** Runtime config set after vault is unlocked */
export interface RuntimeConfig {
  botToken: string;
  users: UsersMap;
  allowedUserIds: number[];
}


let _runtime: RuntimeConfig | null = null;

export function setRuntimeConfig(rc: RuntimeConfig) {
  _runtime = rc;
}

export function refreshRuntimeConfigFromVault(vault: Vault) {
  const users = normalizeUsers(vault.get("steve/users")).users;
  setRuntimeConfig({
    botToken: getTelegramBotToken(vault) || "",
    users,
    allowedUserIds: getAllowedTelegramIds(users),
  });
}

export function getRuntime(): RuntimeConfig {
  if (!_runtime) throw new Error("Runtime config not initialized — call setRuntimeConfig first");
  return _runtime;
}

export const config: SteveConfig = Object.freeze({
  projectRoot,
  steveDir,
  stateDir,
  dataDir: steveDir,
  usersDir: join(steveDir, "users"),
  sharedDir: join(steveDir, "shared"),
  defaultsDir: join(projectRoot, "defaults"),
  defaultSkillsDir: join(projectRoot, "defaults/skills"),
  vaultDir,
  mcpPort,
  webPort,
  opencodePortBase,
  browserViewerPortBase,
  browserViewerPortMax,
  browserVncPortBase,
  browserDisplayBase,
  telegramApiBase,
});

export function getTelegramApiBase(): string {
  return config.telegramApiBase.replace(/\/$/, "");
}

function getSystemSettingsPath(): string {
  return join(config.dataDir, "system-settings.json");
}

function getRemoteBrowserRuntimePath(): string {
  return join(config.stateDir, "remote-browser.json");
}

function readRemoteBrowserRuntime(): Partial<BrowserSettings> {
  try {
    const path = getRemoteBrowserRuntimePath();
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<BrowserSettings>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function isValidTimezone(value: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function getDefaultTimezone(): string {
  return DEFAULT_TIMEZONE;
}

export function readSystemSettings(): SteveSystemSettings {
  try {
    const path = getSystemSettingsPath();
    if (!existsSync(path)) {
      return { timezone: DEFAULT_TIMEZONE, browser: DEFAULT_BROWSER_SETTINGS };
    }
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<SteveSystemSettings>;
    const timezone = typeof parsed.timezone === "string" && isValidTimezone(parsed.timezone)
      ? parsed.timezone
      : DEFAULT_TIMEZONE;
    const browser = parsed.browser && typeof parsed.browser === "object"
      ? {
          enabled: true,
          defaultTarget: "container" as BrowserSettings["defaultTarget"],
          artifactsRetentionDays: Number(parsed.browser.artifactsRetentionDays) > 0 ? Number(parsed.browser.artifactsRetentionDays) : DEFAULT_BROWSER_SETTINGS.artifactsRetentionDays,
          remoteEnabled: parsed.browser.remoteEnabled !== undefined
            ? parsed.browser.remoteEnabled !== false
            : typeof parsed.browser.remoteBaseUrl === "string"
              ? parsed.browser.remoteBaseUrl.length > 0
              : DEFAULT_BROWSER_SETTINGS.remoteEnabled,
          remoteBaseUrl: typeof parsed.browser.remoteBaseUrl === "string" ? parsed.browser.remoteBaseUrl : DEFAULT_BROWSER_SETTINGS.remoteBaseUrl,
        }
      : DEFAULT_BROWSER_SETTINGS;
    return { timezone, browser };
  } catch {
    return { timezone: DEFAULT_TIMEZONE, browser: DEFAULT_BROWSER_SETTINGS };
  }
}

export function writeSystemSettings(settings: Partial<SteveSystemSettings>): SteveSystemSettings {
  const next: SteveSystemSettings = {
    ...readSystemSettings(),
    ...settings,
  };
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(getSystemSettingsPath(), `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return next;
}

export function getSystemTimezone(): string {
  return readSystemSettings().timezone;
}

export function getBrowserSettings(): BrowserSettings {
  const persisted = readSystemSettings().browser;
  const runtime = readRemoteBrowserRuntime();
  return {
    ...persisted,
    ...(typeof runtime.remoteEnabled === "boolean" ? { remoteEnabled: runtime.remoteEnabled } : {}),
    ...(typeof runtime.remoteBaseUrl === "string" ? { remoteBaseUrl: runtime.remoteBaseUrl } : {}),
  };
}

export function getBrowserViewerUrl(port: number): string {
  const host = process.env.STEVE_HOSTNAME || "localhost";
  const hostname = host === "localhost" || host.includes(".") ? host : `${host}.local`;
  return `http://${hostname}:${port}/vnc.html?autoconnect=1&resize=scale`;
}

export function getSteveVersion(): string {
  return process.env.STEVE_VERSION || "dev";
}

/** Get the base URL for Steve's web UI — single source of truth */
export function getBaseUrl(): string {
  const host = process.env.STEVE_HOSTNAME || "localhost";
  const hostname = host === "localhost" || host.includes(".") ? host : `${host}.local`;
  return `http://${hostname}:${config.webPort}`;
}

export { steveDir };
