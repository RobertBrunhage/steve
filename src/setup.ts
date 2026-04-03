import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  cpSync,
} from "node:fs";
import { join } from "node:path";
import { syncUserAgentsRuntime } from "./agents.js";
import { steveDir, config, getUserSkillsDir } from "./config.js";
import { getTelegramBotToken } from "./secrets.js";
import { syncBundledSkillsForUser, validateProjectScriptsManifest, validateSkillDirectories } from "./skills.js";
import { Vault, readKeyfile, initializeVault, hasKeyfile } from "./vault/index.js";
import { normalizeUsers, toUserSlug, type UsersMap, uniqueUserSlugs, writeUserManifest } from "./users.js";

// --- Directory and config setup ---

function createDirectories() {
  mkdirSync(steveDir, { recursive: true });
  mkdirSync(config.usersDir, { recursive: true });
  mkdirSync(config.sharedDir, { recursive: true });
}

export function setupUserWorkspace(userName: string) {
  const userDir = join(config.usersDir, toUserSlug(userName));
  for (const sub of ["memory", "memory/daily", "memory/nutrition", "memory/training", "memory/body-measurements", "skills", ".opencode-data"]) {
    mkdirSync(join(userDir, sub), { recursive: true });
  }

  const profilePath = join(userDir, "memory", "profile.md");
  if (!existsSync(profilePath)) {
    writeFileSync(profilePath, `# Profile\n\n## Name\n${userName}\n`, "utf-8");
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
}

export function generateRuntimeConfig(users: UsersMap) {
  const mcpConfig = {
    type: "remote" as const,
    url: `http://steve:${config.mcpPort}/mcp`,
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

  function mergeSteveOpenCodeDefaults(existing: Record<string, unknown>): Record<string, unknown> {
    const agent = isRecord(existing.agent) ? { ...existing.agent } : {};
    const build = isRecord(agent.build) ? { ...agent.build } : {};
    const plan = isRecord(agent.plan) ? { ...agent.plan } : {};
    const mcp = isRecord(existing.mcp) ? { ...existing.mcp } : {};

    return {
      ...existing,
      $schema: "https://opencode.ai/config.json",
      default_agent: "steve",
      agent: {
        ...agent,
        build: { ...build, disable: true },
        plan: { ...plan, disable: true },
      },
      mcp: {
        ...mcp,
        steve: mcpConfig,
      },
    };
  }

  for (const userName of uniqueUserSlugs(users)) {
    const userDir = join(config.usersDir, toUserSlug(userName));
    mkdirSync(userDir, { recursive: true });

    const agentMd = `---
description: >-
  Steve is a personal household assistant. Use this agent for all conversations.
mode: primary
tools:
  task: false
  todowrite: false
  todoread: false
  webfetch: true
  skill: false
  bash: true
permissions:
  - permission: external_directory
    pattern: "*"
    action: allow
  - permission: question
    action: deny
    pattern: "*"
  - permission: plan_enter
    action: deny
    pattern: "*"
  - permission: plan_exit
    action: deny
    pattern: "*"
---

Current Steve user: ${userName}
When calling send_message, always use this exact userName: ${userName}
`;

    const opencodePath = join(userDir, "opencode.json");
    const nextOpenCodeConfig = mergeSteveOpenCodeDefaults(readExistingOpenCodeConfig(opencodePath));
    writeFileSync(opencodePath, `${JSON.stringify(nextOpenCodeConfig, null, 2)}\n`, "utf-8");

    const agentDir = join(userDir, ".opencode", "agents");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "steve.md"), agentMd, "utf-8");

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
  } else if (process.env.STEVE_VAULT_PASSWORD) {
    // First run via local/provisioned startup — create keyfile from password env var
    const password = process.env.STEVE_VAULT_PASSWORD;
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

  const botToken = getTelegramBotToken(vault);
  const users = normalizeUsers(vault.get("steve/users")).users;

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
  writeUserManifest(steveDir, users);
  syncUserAgentsRuntime(users);

  return { vault, botToken, users };
}
