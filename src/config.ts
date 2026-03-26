import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const steveDir = process.env.STEVE_DIR || join(homedir(), ".steve");

const vaultPath = join("/vault", "secrets.enc");
const mcpPort = Number(process.env.STEVE_MCP_PORT) || 3100;
const webPort = Number(process.env.STEVE_WEB_PORT) || 3000;

// users map: { "telegram_id": "Name" }
export type UsersMap = Record<string, string>;

export interface SteveConfig {
  projectRoot: string;
  steveDir: string;
  dataDir: string;
  usersDir: string;
  sharedDir: string;
  skillsDir: string;
  defaultsDir: string;
  defaultSkillsDir: string;
  vaultPath: string;
  mcpPort: number;
  webPort: number;
}

/** Get the workspace directory for a specific user */
export function getUserDir(userName: string): string {
  return join(config.usersDir, userName.toLowerCase());
}

/** Runtime config set after vault is unlocked */
export interface RuntimeConfig {
  botToken: string;
  users: UsersMap;
  allowedUserIds: number[];
}

export const DEFAULT_MODEL = "openai/gpt-5.2";

/** Read a user's model preference from their settings.json */
export function getUserModel(userName: string): string {
  const settingsPath = join(getUserDir(userName), "settings.json");
  try {
    if (existsSync(settingsPath)) {
      const data = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (data.model) return data.model;
    }
  } catch {}
  return DEFAULT_MODEL;
}

let _runtime: RuntimeConfig | null = null;

export function setRuntimeConfig(rc: RuntimeConfig) {
  _runtime = rc;
}

export function getRuntime(): RuntimeConfig {
  if (!_runtime) throw new Error("Runtime config not initialized — call setRuntimeConfig first");
  return _runtime;
}

export const config: SteveConfig = Object.freeze({
  projectRoot,
  steveDir,
  dataDir: steveDir,
  usersDir: join(steveDir, "users"),
  sharedDir: join(steveDir, "shared"),
  skillsDir: join(steveDir, "skills"),
  defaultsDir: join(projectRoot, "defaults"),
  defaultSkillsDir: join(projectRoot, "defaults/skills"),
  vaultPath,
  mcpPort,
  webPort,
});

export { steveDir };
