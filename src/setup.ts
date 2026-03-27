import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  cpSync,
} from "node:fs";
import { join } from "node:path";
import { steveDir, config } from "./config.js";
import { Vault, readKeyfile, initializeVault, hasKeyfile } from "./vault/index.js";

// --- Directory and config setup ---

function createDirectories() {
  mkdirSync(steveDir, { recursive: true });
  mkdirSync(config.usersDir, { recursive: true });
  mkdirSync(config.sharedDir, { recursive: true });
  mkdirSync(config.skillsDir, { recursive: true });
}

/** Sync project default skills to the shared skills directory */
function syncSkills() {
  const src = config.defaultSkillsDir;
  if (!existsSync(src)) return;

  for (const entry of readdirSync(src)) {
    cpSync(join(src, entry), join(config.skillsDir, entry), { recursive: true });
  }
}

function setupUserWorkspace(userName: string) {
  const userDir = join(config.usersDir, userName.toLowerCase());
  for (const sub of ["memory", "memory/daily", "memory/nutrition", "memory/training", "memory/body-measurements"]) {
    mkdirSync(join(userDir, sub), { recursive: true });
  }

  // Sync project-controlled files
  for (const file of ["SOUL.md", "AGENTS.md"]) {
    const src = join(config.defaultsDir, file);
    if (existsSync(src)) {
      cpSync(src, join(userDir, file));
    }
  }

  // shared/ and skills/ are mounted via Docker volumes, no symlinks needed

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

function generateRuntimeConfig(users: Record<string, string>) {
  const mcpConfig = {
    type: "remote" as const,
    url: `http://steve:${config.mcpPort}/mcp`,
    enabled: true,
  };

  const opencodeJson = JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    mcp: { steve: mcpConfig },
  }, null, 2);

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
`;

  for (const userName of Object.values(users)) {
    const userDir = join(config.usersDir, userName.toLowerCase());
    mkdirSync(userDir, { recursive: true });

    writeFileSync(join(userDir, "opencode.json"), opencodeJson, "utf-8");

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
  users: Record<string, string>;
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
    // First run via launch.ts — create keyfile from password env var
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

  const botToken = vault.getString("telegram/bot_token");
  const users = vault.get("steve/users") as Record<string, string> | null;

  if (!botToken || !users || Object.keys(users).length === 0) {
    createDirectories();
    return { vault, botToken: botToken || "", users: users || {} };
  }

  // Full setup
  createDirectories();
  syncSkills();
  for (const userName of Object.values(users)) {
    setupUserWorkspace(userName);
  }
  generateRuntimeConfig(users);

  // Write user manifest for launch script
  const userList = [...new Set(Object.values(users).map((n) => n.toLowerCase()))];
  writeFileSync(
    join(steveDir, "users.json"),
    JSON.stringify({ users: userList }, null, 2),
    "utf-8",
  );

  return { vault, botToken, users };
}
