import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  cpSync,
  unlinkSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import {
  APP_NAME,
  APP_SLUG,
  LEGACY_OPENCODE_AGENT_NAME,
  OPENCODE_AGENT_FILE,
} from "./brand.js";
import { syncUserAgentsRuntime } from "./agents.js";
import { kellixDir, config, getUserAgentDir, getUserAgentSkillsDir, getUserAgentWorkflowsDir, getUserDir } from "./config.js";
import { migrateLegacyUserJobs } from "./scheduler.js";
import { getTelegramBotToken } from "./secrets.js";
import { syncBundledSkillsForUser, syncBundledWorkflowDocs, validateProjectScriptsManifest, validateSkillDirectories } from "./skills.js";
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

/**
 * Move a legacy user-root file/dir into the kellix agent workspace.
 * Idempotent: only moves when source exists and destination does not.
 */
function moveLegacyEntry(src: string, dest: string): void {
  if (!existsSync(src)) return;
  if (existsSync(dest)) return;
  mkdirSync(join(dest, ".."), { recursive: true });
  try {
    renameSync(src, dest);
  } catch {
    try {
      cpSync(src, dest, { recursive: true });
      rmSync(src, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * One-shot migration of pre-refactor user-root files into the default kellix
 * agent workspace. Idempotent — safe to run on every startup.
 */
function migrateLegacyUserWorkspace(userName: string): void {
  const userDir = getUserDir(userName);
  const kellixAgentDir = getUserAgentDir(userName, APP_SLUG);
  mkdirSync(kellixAgentDir, { recursive: true });

  for (const file of ["SOUL.md", "AGENTS.md"]) {
    moveLegacyEntry(join(userDir, file), join(kellixAgentDir, file));
  }
  for (const dir of ["memory", "skills", ".opencode-data"]) {
    moveLegacyEntry(join(userDir, dir), join(kellixAgentDir, dir));
  }
  // Legacy user-root opencode.json belongs to the kellix agent now.
  moveLegacyEntry(join(userDir, "opencode.json"), join(kellixAgentDir, "opencode.json"));

  // Legacy .opencode plugins → kellix agent's plugins dir.
  const legacyPluginDir = join(userDir, ".opencode", "plugins");
  const kellixPluginDir = join(kellixAgentDir, ".opencode", "plugins");
  if (existsSync(legacyPluginDir) && !existsSync(kellixPluginDir)) {
    try {
      mkdirSync(kellixPluginDir, { recursive: true });
      for (const file of readdirSync(legacyPluginDir)) {
        cpSync(join(legacyPluginDir, file), join(kellixPluginDir, file));
      }
      rmSync(legacyPluginDir, { recursive: true, force: true });
    } catch {}
  }

  // Legacy .opencode/agents/* — generated content; drop, it'll be re-emitted under each agent dir.
  const legacyAgentsDir = join(userDir, ".opencode", "agents");
  if (existsSync(legacyAgentsDir)) {
    try { rmSync(legacyAgentsDir, { recursive: true, force: true }); } catch {}
  }
  // Clean up empty user-root .opencode dir.
  const legacyOpencodeRoot = join(userDir, ".opencode");
  if (existsSync(legacyOpencodeRoot)) {
    try {
      if (readdirSync(legacyOpencodeRoot).length === 0) rmSync(legacyOpencodeRoot, { recursive: true, force: true });
    } catch {}
  }

  // Split legacy user-root jobs.json into per-agent files.
  migrateLegacyUserJobs(userName);
}

export function setupUserWorkspace(userName: string) {
  const userDir = getUserDir(userName);
  mkdirSync(userDir, { recursive: true });

  migrateLegacyUserWorkspace(userName);

  const userAgents = readUserAgentsConfig(userName);
  writeUserAgentsConfig(userName, userAgents);

  for (const agent of userAgents.agents) {
    const agentRoot = getUserAgentDir(userName, agent.id);
    for (const sub of [
      "memory",
      "memory/daily",
      "memory/nutrition",
      "memory/training",
      "memory/body-measurements",
      "skills",
      "jobs",
      ".opencode-data",
      ".opencode/plugins",
      ".opencode/agents",
    ]) {
      mkdirSync(join(agentRoot, sub), { recursive: true });
    }

    for (const file of ["SOUL.md", "AGENTS.md"]) {
      const src = join(config.defaultsDir, file);
      const dest = join(agentRoot, file);
      if (existsSync(src) && !existsSync(dest)) cpSync(src, dest);
    }

    const profilePath = join(agentRoot, "memory", "profile.md");
    if (agent.id === APP_SLUG && !existsSync(profilePath)) {
      writeFileSync(profilePath, getDefaultProfileContent(userName), "utf-8");
    }

    // OpenCode memory-flush plugin lives inside each agent's home so the
    // per-agent OpenCode container can pick it up at /data/.opencode/plugins.
    const pluginSrc = join(config.defaultsDir, "opencode-plugin");
    if (existsSync(pluginSrc)) {
      const pluginDest = join(agentRoot, ".opencode", "plugins");
      mkdirSync(pluginDest, { recursive: true });
      for (const file of readdirSync(pluginSrc)) {
        cpSync(join(pluginSrc, file), join(pluginDest, file));
      }
    }

    // Every agent gets the workflow spec + JSON Schema alongside any of its
    // own .workflow.yaml files. Examples stay in defaults/workflows/examples/
    // and are referenced by docs (they have cron triggers and shouldn't fire
    // on every agent automatically).
    syncBundledWorkflowDocs(config.defaultWorkflowsDir, getUserAgentWorkflowsDir(userName, agent.id));

    if (agent.id === APP_SLUG) {
      syncBundledSkillsForUser(config.defaultSkillsDir, getUserAgentSkillsDir(userName, agent.id));
    } else {
      // Specialists start with an empty skills/ folder, but they still need
      // the structural reference so "read skills/TEMPLATE.md" in AGENTS.md is
      // actionable. Copy just the template files, not the kellix-bundled skills.
      const skillsDest = getUserAgentSkillsDir(userName, agent.id);
      mkdirSync(skillsDest, { recursive: true });
      for (const template of ["TEMPLATE.md", "OAUTH_TEMPLATE.md"]) {
        const src = join(config.defaultSkillsDir, template);
        const dest = join(skillsDest, template);
        if (existsSync(src) && !existsSync(dest)) cpSync(src, dest);
      }

      // Seed OpenCode auth from the kellix agent so specialists don't have to
      // re-sign-in. One-shot copy — refreshes don't propagate, which is fine
      // for everyday use; the user can re-seed by removing the specialist's
      // auth.json or re-signing in.
      const kellixAuth = join(getUserAgentDir(userName, APP_SLUG), ".opencode-data", "auth.json");
      const agentAuth = join(agentRoot, ".opencode-data", "auth.json");
      if (existsSync(kellixAuth) && !existsSync(agentAuth)) {
        cpSync(kellixAuth, agentAuth);
      }
    }
  }
}

function renderOpenCodeAgentFile(userName: string, agent: KellixUserAgent): string {
  const roleSummary = agent.roleSummary || agent.goal || "";
  const instructions = agent.instructions || "";
  const description = agent.id === APP_SLUG
    ? `${APP_NAME} is a personal household assistant. Use this agent for all conversations.`
    : `${agent.name}: ${roleSummary || "Specialized Kellix agent."}`;
  const profileBlock = agent.setupStatus === "needs_setup"
    ? `This specialist agent is not configured yet.

Your first responsibility is to interview the user and learn what this specialist should do. Ask concise questions to understand:
- what you are responsible for
- what you should not do
- what memory you should keep
- whether scheduled work would be useful
- how you should report back

Once you have enough information, update /data/AGENTS.md with a short role summary and durable multiline instructions. Then continue helping from that profile.`
    : `Agent role: ${roleSummary || "Use the shared Kellix instructions and help the user."}

Agent instructions:
${instructions || "Use the shared Kellix instructions and help the user."}`;

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
Agent setup status: ${agent.setupStatus || "configured"}

${profileBlock}

Your home workspace is /data. Treat it as this agent's private root.
Read /data/SOUL.md and /data/AGENTS.md first.
Use /data/memory for private memory.
Use /data/skills for skills.
Use /data/jobs for agent-owned jobs.
Use /data/shared only for household-wide context when explicitly relevant.
When calling send_message, send_file, manage_jobs, or run_script, always use this exact userName: ${userName} and agentId: ${agent.id}
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

  function mergeKellixOpenCodeDefaults(existing: Record<string, unknown>, agentId: string): Record<string, unknown> {
    const agent = isRecord(existing.agent) ? { ...existing.agent } : {};
    const build = isRecord(agent.build) ? { ...agent.build } : {};
    const plan = isRecord(agent.plan) ? { ...agent.plan } : {};
    const mcp = isRecord(existing.mcp) ? { ...existing.mcp } : {};
    delete mcp[LEGACY_OPENCODE_AGENT_NAME];

    return {
      ...existing,
      $schema: "https://opencode.ai/config.json",
      default_agent: agentId,
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
    const userDir = getUserDir(userName);
    mkdirSync(userDir, { recursive: true });

    const userAgents = readUserAgentsConfig(userName);
    writeUserAgentsConfig(userName, userAgents);

    for (const agent of userAgents.agents) {
      const agentDir = getUserAgentDir(userName, agent.id);
      mkdirSync(agentDir, { recursive: true });

      const opencodePath = join(agentDir, "opencode.json");
      const nextOpenCodeConfig = mergeKellixOpenCodeDefaults(readExistingOpenCodeConfig(opencodePath), agent.id);
      writeFileSync(opencodePath, `${JSON.stringify(nextOpenCodeConfig, null, 2)}\n`, "utf-8");

      const agentFileDir = join(agentDir, ".opencode", "agents");
      mkdirSync(agentFileDir, { recursive: true });
      const fileName = agent.id === APP_SLUG ? OPENCODE_AGENT_FILE : `${agent.id}.md`;
      writeFileSync(join(agentFileDir, fileName), renderOpenCodeAgentFile(userName, agent), "utf-8");

      writeFileSync(
        join(agentDir, ".gitignore"),
        "tmp/\nopencode.json\n.opencode/\n",
        "utf-8",
      );
    }

    // Drop any orphaned generated agent .md files from agents that have been deleted.
    for (const agent of userAgents.agents) {
      const agentFilesDir = join(getUserAgentDir(userName, agent.id), ".opencode", "agents");
      if (!existsSync(agentFilesDir)) continue;
      try {
        for (const file of readdirSync(agentFilesDir)) {
          if (file === `${agent.id}.md` || file === OPENCODE_AGENT_FILE) continue;
          try { unlinkSync(join(agentFilesDir, file)); } catch {}
        }
      } catch {}
    }
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
    const kf = readKeyfile(config.vaultDir);
    if (!kf) {
      console.error("Failed to read vault keyfile.");
      process.exit(1);
    }
    keyfile = kf;
  } else if (process.env.KELLIX_VAULT_PASSWORD || process.env.STEVE_VAULT_PASSWORD) {
    const password = process.env.KELLIX_VAULT_PASSWORD || process.env.STEVE_VAULT_PASSWORD || "";
    delete process.env.KELLIX_VAULT_PASSWORD;
    delete process.env.STEVE_VAULT_PASSWORD;
    keyfile = initializeVault(config.vaultDir, password);
  } else {
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

  createDirectories();
  validateProjectScriptsManifest(config.projectRoot);
  for (const userName of uniqueUserSlugs(users)) {
    setupUserWorkspace(userName);
    for (const agent of readUserAgentsConfig(userName).agents) {
      validateSkillDirectories(getUserAgentSkillsDir(userName, agent.id));
    }
  }
  generateRuntimeConfig(users);

  writeUserManifest(kellixDir, users);
  syncUserAgentsRuntime(users);

  return { vault, botToken, users };
}
