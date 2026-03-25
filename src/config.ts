import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const steveDir = process.env.STEVE_DIR || join(homedir(), ".steve");
const configPath = join(steveDir, "config.json");

const isDocker = process.env.STEVE_DOCKER === "1";
const vaultPath = join(isDocker ? "/vault" : steveDir, "secrets.enc");
const opencodeUrl = process.env.OPENCODE_URL || "http://localhost:3456";
const mcpPort = Number(process.env.STEVE_MCP_PORT) || 3100;
const webPort = Number(process.env.STEVE_WEB_PORT) || 3000;

// users map: { "telegram_id": "Name" }
type UsersMap = Record<string, string>;

interface SteveConfig {
  telegram: {
    botToken: string | undefined;
    allowedUserIds: number[];
    users: UsersMap;
  };
  model: string;
  projectRoot: string;
  steveDir: string;
  dataDir: string;
  memoryDir: string;
  skillsDir: string;
  defaultsDir: string;
  defaultSkillsDir: string;
  isDocker: boolean;
  vaultPath: string;
  opencodeUrl: string;
  mcpPort: number;
  webPort: number;
}

function loadConfig(): SteveConfig {
  let fileConfig: Record<string, any> = {};

  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      // Corrupt config, will use defaults
    }
  }

  const users: UsersMap = fileConfig.users || {};
  const allowedUserIds = Object.keys(users).map(Number).filter((id) => id > 0);

  return Object.freeze({
    telegram: {
      botToken: fileConfig.telegram_bot_token || undefined,
      allowedUserIds,
      users,
    },
    model: fileConfig.model || "openai/gpt-5.2",
    projectRoot,
    steveDir,
    dataDir: steveDir,
    memoryDir: join(steveDir, "memory"),
    skillsDir: join(steveDir, "skills"),
    defaultsDir: join(projectRoot, "defaults"),
    defaultSkillsDir: join(projectRoot, "defaults/skills"),
    isDocker,
    vaultPath,
    opencodeUrl,
    mcpPort,
    webPort,
  });
}

export const config = loadConfig();
export { configPath, steveDir };
