// Shared script resolution + execution. Used by the run_script MCP tool and
// workflow `run`/`script` steps so both go through the same allowlist + secret
// injection + audit pipeline.

import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { appendUserActivity } from "../activity.js";
import { APP_SLUG } from "../brand.js";
import { config, getBaseUrl } from "../config.js";
import { toUserSlug } from "../users.js";
import type { Vault } from "../vault/index.js";
import { appendRunScriptAudit } from "./audit.js";
import { buildScriptExecutionContext, redactSecrets } from "./script-security.js";

function extractAgentIdFromPath(scriptPath: string, dataDir: string, userName: string): string | null {
  // Match users/<user>/agents/<agent>/.agents/skills/<skill>/... — used
  // to inject KELLIX_AGENT_ID into the script env so skill helpers can
  // translate /data/* paths to the calling agent's workspace.
  const userAgentsRoot = resolve(join(dataDir, "users", toUserSlug(userName), "agents"));
  const resolved = resolve(scriptPath);
  if (!resolved.startsWith(userAgentsRoot + "/")) return null;
  const rel = relative(userAgentsRoot, resolved);
  const [agentId] = rel.split("/");
  return agentId || null;
}

export function discoverProjectScripts(projectRoot: string): Set<string> {
  const scripts = new Set<string>();
  const dir = join(projectRoot, "scripts");
  try {
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".sh")) {
        scripts.add(resolve(join(dir, file)));
      }
    }
  } catch {}
  return scripts;
}

/** Check if a script lives inside a user's skills/scripts/ directory. */
export function isSkillScript(scriptPath: string, dataDir: string): boolean {
  const resolved = resolve(scriptPath);
  const usersDir = resolve(join(dataDir, "users"));
  if (resolved.startsWith(usersDir + "/")) {
    const relative = resolved.slice(usersDir.length + 1);
    const parts = relative.split("/");
    // Legacy user-level skill: users/<user>/skills/<skill>/scripts/<file>.sh
    const legacyUserSkill = parts.length === 5
      && parts[1] === "skills"
      && parts[3] === "scripts"
      && parts[4].endsWith(".sh");
    // Agent-local skill: users/<user>/agents/<agent>/.agents/skills/<skill>/scripts/<file>.sh
    const agentSkill = parts.length === 8
      && parts[1] === "agents"
      && parts[3] === ".agents"
      && parts[4] === "skills"
      && parts[6] === "scripts"
      && parts[7].endsWith(".sh");
    return legacyUserSkill || agentSkill;
  }
  return false;
}

/** Extract skill name from a script path like skills/withings/scripts/fetch.sh → withings */
export function getSkillFromPath(scriptPath: string): string | null {
  const parts = scriptPath.split("/");
  const scriptsIdx = parts.lastIndexOf("scripts");
  if (scriptsIdx > 0) return parts[scriptsIdx - 1];
  return null;
}

export interface ResolveOptions {
  /** Input script path. May be relative ("skills/x/scripts/y.sh"), container-rooted ("/data/skills/..."), or absolute on host. */
  script: string;
  userName: string;
  agentId?: string;
  dataDir: string;
  projectScripts: Set<string>;
}

export type ResolveResult =
  | { ok: true; resolved: string; skill: string | null }
  | { ok: false; error: string };

export function resolveAllowedScript(opts: ResolveOptions): ResolveResult {
  const { script, userName, dataDir, projectScripts } = opts;
  const scriptAgentId = toUserSlug(opts.agentId || APP_SLUG);

  let scriptPath = script;
  // Accept agent-prefixed paths first (cross-agent invocation), then the
  // spec-aligned `.agents/skills/...` form, then bare `skills/...` (the
  // common case — the calling agent's own skills).
  const agentSkillsMatch = script.match(/(?:^|\/)agents\/([^/]+)\/(?:\.agents\/)?(skills\/.+)$/);
  const skillsMatch = script.match(/(?:^|\/)(?:\.agents\/)?(skills\/.+)$/);

  if (agentSkillsMatch) {
    if (!userName) return { ok: false, error: "Skill scripts require the current user name as the first argument." };
    scriptPath = join(dataDir, "users", userName, "agents", toUserSlug(agentSkillsMatch[1] || scriptAgentId), ".agents", agentSkillsMatch[2] || "");
  } else if (skillsMatch) {
    if (!userName) return { ok: false, error: "Skill scripts require the current user name as the first argument." };
    scriptPath = join(dataDir, "users", userName, "agents", scriptAgentId, ".agents", skillsMatch[1]);
  }

  const resolved = resolve(scriptPath);
  if (!projectScripts.has(resolved) && !isSkillScript(resolved, dataDir)) {
    return { ok: false, error: "Script not allowed. Must be in project scripts/ or skills/*/scripts/." };
  }
  if (!existsSync(resolved)) {
    return { ok: false, error: `Script not found: ${script}` };
  }
  return { ok: true, resolved, skill: getSkillFromPath(resolved) };
}

export interface ExecuteOptions {
  resolved: string;
  args: string[];
  userName: string;
  vault: Vault | null;
  dataDir: string;
  projectRoot: string;
  /** Skill name (for audit/activity summary). */
  skill: string | null;
  timeoutMs?: number;
  /** Extra env merged on top of the standard set. */
  env?: Record<string, string>;
  /** Source label used in the activity log summary (e.g. "Script ran" / "Workflow step"). */
  activityLabel?: { ok: string; error: string };
}

export interface ExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  secretKeys: string[];
  redactionCount: number;
}

export async function executeAllowedScript(opts: ExecuteOptions): Promise<ExecuteResult> {
  const { resolved, args, userName, vault, dataDir, projectRoot, skill } = opts;
  const scriptContext = buildScriptExecutionContext({ vault, userName, scriptPath: resolved, dataDir, projectRoot });

  return new Promise((res) => {
    const startedAt = Date.now();
    execFile("bash", [resolved, ...args], {
      timeout: opts.timeoutMs ?? 300_000,
      env: {
        ...process.env,
        KELLIX_PROJECT_ROOT: projectRoot,
        KELLIX_DATA_DIR: dataDir,
        KELLIX_BASE_URL: getBaseUrl(),
        KELLIX_USER_NAME: userName,
        ...(() => {
          const agentId = extractAgentIdFromPath(resolved, dataDir, userName);
          return agentId ? { KELLIX_AGENT_ID: agentId } : {};
        })(),
        STEVE_PROJECT_ROOT: projectRoot,
        STEVE_DATA_DIR: dataDir,
        STEVE_BASE_URL: getBaseUrl(),
        ...scriptContext.env,
        ...(opts.env ?? {}),
      },
    }, (error, stdout, stderr) => {
      let output = stdout || "";
      try {
        const parsed = JSON.parse(output);
        if (parsed.save_to_vault && vault) {
          const { key, value } = parsed.save_to_vault;
          if (key && value) vault.set(key, value);
          delete parsed.save_to_vault;
          output = JSON.stringify(parsed);
        }
      } catch {}

      const redactedOutput = scriptContext.redactOutput
        ? redactSecrets(output, scriptContext.injectedSecretValues)
        : { text: output, redactionCount: 0 };
      const redactedError = scriptContext.redactOutput
        ? redactSecrets(stderr || "", scriptContext.injectedSecretValues)
        : { text: stderr || "", redactionCount: 0 };

      const durationMs = Date.now() - startedAt;
      const exitCode = error
        ? (error as NodeJS.ErrnoException & { code?: number }).code === undefined
          ? 1
          : Number((error as { code?: number }).code) || 1
        : 0;

      const auditEntry = {
        timestamp: new Date().toISOString(),
        userName,
        script: resolved,
        status: error ? "error" as const : "ok" as const,
        durationMs,
        secretKeys: scriptContext.injectedSecretKeys,
        usedManifest: scriptContext.usedManifest,
        redactionCount: redactedOutput.redactionCount + redactedError.redactionCount,
      };
      appendRunScriptAudit(dataDir, auditEntry);
      const labels = opts.activityLabel ?? { ok: "Script ran", error: "Script failed" };
      appendUserActivity(config.dataDir, {
        timestamp: auditEntry.timestamp,
        userName: userName || "system",
        type: "script",
        status: error ? "error" : "ok",
        summary: `${error ? labels.error : labels.ok}: ${skill ? `${skill}/` : ""}${basename(resolved)}`,
      });

      res({
        stdout: redactedOutput.text,
        stderr: redactedError.text,
        exitCode,
        durationMs,
        secretKeys: scriptContext.injectedSecretKeys,
        redactionCount: redactedOutput.redactionCount + redactedError.redactionCount,
      });
    });
  });
}
