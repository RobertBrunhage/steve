import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const steveDir = process.env.STEVE_DIR || join(homedir(), ".steve");

const vaultDir = process.env.STEVE_VAULT_DIR || "/vault";
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
  vaultDir: string;
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
  vaultDir,
  mcpPort,
  webPort,
});

export { steveDir };
