import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  cpSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import {
  APP_NAME,
  APP_SLUG,
  LEGACY_OPENCODE_AGENT_FILE,
  LEGACY_OPENCODE_AGENT_NAME,
  OPENCODE_AGENT_FILE,
} from "./brand.js";
import { syncUserAgentsRuntime } from "./agents.js";
import { kellixDir, config, getUserSkillsDir } from "./config.js";
import { getTelegramBotToken } from "./secrets.js";
import { syncBundledSkillsForUser, validateProjectScriptsManifest, validateSkillDirectories } from "./skills.js";
import { readUserAgentsConfig, writeUserAgentsConfig, type KellixUserAgent } from "./user-agents.js";
import { Vault, readKeyfile, initializeVault, hasKeyfile } from "./vault/index.js";
import { migrateUsersVaultKey, readUsersFromVault, toUserSlug, type UsersMap, uniqueUserSlugs, writeUserManifest } from "./users.js";
import { migrateLegacyAdminAuthKey } from "./web/auth.js";

// --- Directory and config setup ---

function createDirectories() {
  mkdirSync(kellixDir, { recursive: true });
  mkdirSync(config.usersDir, { recursive: true });
  mkdirSync(config.sharedDir, { recursive: true });
}

function getDefaultProfileContent(userName: string) {
  const templatePath = join(config.defaultSkillsDir, "personalization", "templates", "profile.md");
  if (!existsSync(templatePath)) {
    return `# Profile\n\n## Name\n${userName}\n`;
  }

  const today = new Date().toISOString().slice(0, 10);
  return readFileSync(templatePath, "utf-8")
    .replaceAll("{User}", userName)
    .replaceAll("YYYY-MM-DD", today);
}

export function setupUserWorkspace(userName: string) {
  const userDir = join(config.usersDir, toUserSlug(userName));
  for (const sub of ["memory", "memory/daily", "memory/nutrition", "memory/training", "memory/body-measurements", "skills", ".opencode-data"]) {
    mkdirSync(join(userDir, sub), { recursive: true });
  }

  const profilePath = join(userDir, "memory", "profile.md");
  if (!existsSync(profilePath)) {
    writeFileSync(profilePath, getDefaultProfileContent(userName), "utf-8");
  }

  // Sync project-controlled files
  for (const file of ["SOUL.md", "AGENTS.md"]) {
    const src = join(config.defaultsDir, file);
    if (existsSync(src)) {
      cpSync(src, join(userDir, file));
    }
  }

  syncBundledSkillsForUser(config.defaultSkillsDir, getUserSkillsDir(userName));

  // Copy OpenCode plugins for memory flush
  const pluginSrc = join(config.defaultsDir, "opencode-plugin");
  const pluginDest = join(userDir, ".opencode", "plugins");
  if (existsSync(pluginSrc)) {
    mkdirSync(pluginDest, { recursive: true });
    for (const file of readdirSync(pluginSrc)) {
      cpSync(join(pluginSrc, file), join(pluginDest, file));
    }
  }

  const userAgents = readUserAgentsConfig(userName);
  writeUserAgentsConfig(userName, userAgents);
  for (const agent of userAgents.agents) {
    const agentRoot = join(userDir, "agents", agent.id);
    for (const sub of ["memory", "memory/daily", "skills", "jobs", ".opencode-data"]) {
      mkdirSync(join(agentRoot, sub), { recursive: true });
    }
  }
}

function renderOpenCodeAgentFile(userName: string, agent: KellixUserAgent): string {
  const description = agent.id === APP_SLUG
    ? `${APP_NAME} is a personal household assistant. Use this agent for all conversations.`
    : `${agent.name}: ${agent.goal || "Specialized Kellix agent."}`;

  return `---
description: >-
  ${description}
mode: primary
tools:
  '*': true
  webfetch: true
  bash: true
permissions:
  - permission: allow
---

Current Kellix user: ${userName}
Current Kellix agent: ${agent.id}
Agent name: ${agent.name}
Agent goal: ${agent.goal || "Use the shared Kellix instructions and help the user."}
Agent workspace: agents/${agent.id}
Use agents/${agent.id}/memory for this agent's private memory and agents/${agent.id}/skills for agent-specific skills.
Use memory/ and skills/ only for user-level shared context.
When calling send_message or send_file, always use this exact userName: ${userName} and agentId: ${agent.id}
`;
}

export function generateRuntimeConfig(users: UsersMap) {
  const mcpConfig = {
    type: "remote" as const,
    url: `http://kellix:${config.mcpPort}/mcp`,
    enabled: true,
  };

  function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function readExistingOpenCodeConfig(path: string): Record<string, unknown> {
    try {
      if (!existsSync(path)) return {};
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function mergeKellixOpenCodeDefaults(existing: Record<string, unknown>): Record<string, unknown> {
    const agent = isRecord(existing.agent) ? { ...existing.agent } : {};
    const build = isRecord(agent.build) ? { ...agent.build } : {};
    const plan = isRecord(agent.plan) ? { ...agent.plan } : {};
    const mcp = isRecord(existing.mcp) ? { ...existing.mcp } : {};
    delete mcp[LEGACY_OPENCODE_AGENT_NAME];

    return {
      ...existing,
      $schema: "https://opencode.ai/config.json",
      default_agent: APP_SLUG,
      agent: {
        ...agent,
        build: { ...build, disable: true },
        plan: { ...plan, disable: true },
      },
      mcp: {
        ...mcp,
        [APP_SLUG]: mcpConfig,
      },
    };
  }

  for (const userName of uniqueUserSlugs(users)) {
    const userDir = join(config.usersDir, toUserSlug(userName));
    mkdirSync(userDir, { recursive: true });

    const opencodePath = join(userDir, "opencode.json");
    const nextOpenCodeConfig = mergeKellixOpenCodeDefaults(readExistingOpenCodeConfig(opencodePath));
    writeFileSync(opencodePath, `${JSON.stringify(nextOpenCodeConfig, null, 2)}\n`, "utf-8");

    const agentDir = join(userDir, ".opencode", "agents");
    mkdirSync(agentDir, { recursive: true });
    const userAgents = readUserAgentsConfig(userName);
    writeUserAgentsConfig(userName, userAgents);
    for (const agent of userAgents.agents) {
      const fileName = agent.id === APP_SLUG ? OPENCODE_AGENT_FILE : `${agent.id}.md`;
      writeFileSync(join(agentDir, fileName), renderOpenCodeAgentFile(userName, agent), "utf-8");
    }
    const legacyAgentPath = join(agentDir, LEGACY_OPENCODE_AGENT_FILE);
    if (existsSync(legacyAgentPath)) {
      unlinkSync(legacyAgentPath);
    }

    writeFileSync(
      join(userDir, ".gitignore"),
      "tmp/\nopencode.json\n.opencode/\n",
      "utf-8",
    );
  }
}

// --- Main export ---

export interface SetupResult {
  vault: Vault | null;
  botToken: string;
  users: UsersMap;
}

export async function runSetup(): Promise<SetupResult> {
  let keyfile: Buffer;

  if (hasKeyfile(config.vaultDir)) {
    // Subsequent run — read keyfile directly
    const kf = readKeyfile(config.vaultDir);
    if (!kf) {
      console.error("Failed to read vault keyfile.");
      process.exit(1);
    }
    keyfile = kf;
  } else if (process.env.KELLIX_VAULT_PASSWORD || process.env.STEVE_VAULT_PASSWORD) {
    // First run via local/provisioned startup — create keyfile from password env var
    const password = process.env.KELLIX_VAULT_PASSWORD || process.env.STEVE_VAULT_PASSWORD || "";
    delete process.env.KELLIX_VAULT_PASSWORD;
    delete process.env.STEVE_VAULT_PASSWORD;
    keyfile = initializeVault(config.vaultDir, password);
  } else {
    // No vault yet — web wizard will handle initialization
    createDirectories();
    return { vault: null, botToken: "", users: {} };
  }

  let vault: Vault;
  try {
    vault = new Vault(config.vaultDir, keyfile);
  } catch (err) {
    console.error("Failed to decrypt vault:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  migrateLegacyAdminAuthKey(vault);
  migrateUsersVaultKey(vault);

  const botToken = getTelegramBotToken(vault);
  const users = readUsersFromVault(vault);

  if (!botToken || !users || Object.keys(users).length === 0) {
    createDirectories();
    return { vault, botToken: botToken || "", users: users || {} };
  }

  // Full setup
  createDirectories();
  validateProjectScriptsManifest(config.projectRoot);
  for (const userName of uniqueUserSlugs(users)) {
    setupUserWorkspace(userName);
    validateSkillDirectories(getUserSkillsDir(userName));
  }
  generateRuntimeConfig(users);

  // Write user manifest for launch script
  writeUserManifest(kellixDir, users);
  syncUserAgentsRuntime(users);

  return { vault, botToken, users };
}
