import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve, normalize, basename, dirname } from "node:path";
import { execFile } from "node:child_process";
import { z } from "zod";
import type { Vault } from "../vault/index.js";
import type { Channel } from "../channels/index.js";
import { config, getBaseUrl } from "../config.js";
import { loadUserJobs, saveUserJobs, type Job } from "../scheduler.js";
import { toUserSlug } from "../users.js";
import { appendRunScriptAudit } from "./audit.js";
import { buildScriptExecutionContext, redactSecrets } from "./script-security.js";

interface McpConfig {
  channel: Channel;
  projectRoot: string;
  dataDir: string;
}

/** Snapshot project scripts at startup (immutable, security-critical) */
function discoverProjectScripts(projectRoot: string): Set<string> {
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

/** Check if a script is inside a skill's scripts/ directory */
function isSkillScript(scriptPath: string, dataDir: string): boolean {
  const resolved = resolve(scriptPath);

  // Check under shared skills dir: skills/*/scripts/*.sh
  const skillsDir = resolve(join(dataDir, "skills"));
  if (resolved.startsWith(skillsDir + "/")) {
    const relative = resolved.slice(skillsDir.length + 1);
    const parts = relative.split("/");
    return parts.length === 3 && parts[1] === "scripts" && parts[2].endsWith(".sh");
  }

  // Check under user workspaces (symlinks resolve to shared skills, but path may come as users/*/skills/*)
  const usersDir = resolve(join(dataDir, "users"));
  if (resolved.startsWith(usersDir + "/")) {
    const relative = resolved.slice(usersDir.length + 1);
    const parts = relative.split("/");
    return parts.length === 5 && parts[1] === "skills" && parts[3] === "scripts" && parts[4].endsWith(".sh");
  }

  return false;
}

/** Extract skill name from a script path like skills/withings/scripts/fetch.sh → withings */
function getSkillFromPath(scriptPath: string): string | null {
  const parts = scriptPath.split("/");
  const scriptsIdx = parts.lastIndexOf("scripts");
  if (scriptsIdx > 0) {
    return parts[scriptsIdx - 1];
  }
  return null;
}

export type McpServerFactory = () => McpServer;

export function createMcpServerFactory(mcpConfig: McpConfig, vault: Vault | null): McpServerFactory {
  const { channel, projectRoot, dataDir } = mcpConfig;
  const projectScripts = discoverProjectScripts(projectRoot);

  return () => {
  const server = new McpServer({
    name: "steve",
    version: "1.0.0",
  });

  server.registerTool("send_message", {
    description:
      "Send a message to a user. Use this to respond to users. This is the ONLY way to communicate with users.",
    inputSchema: {
      userName: z.string().describe("The name of the user to send the message to"),
      message: z.string().describe("The message text to send (supports HTML)"),
      buttons: z.array(z.array(z.string())).optional().describe("Optional inline button rows, e.g. [['Yes','No']]"),
    },
  }, async ({ userName, message, buttons }) => {
    const result = await channel.sendMessage(userName, message, buttons ? { buttons } : undefined);
    if (!result.ok) {
      console.warn(`send_message failed for ${userName}: ${result.error || "unknown error"}`);
      return {
        content: [{ type: "text", text: `Error: ${result.error || "unknown error"}` }],
        isError: true,
      };
    }

    console.log(`send_message delivered for ${userName}`);

    return {
      content: [{ type: "text", text: `Message sent to ${userName}` }],
    };
  });

  server.registerTool("session_status", {
    description:
      "Get the current time, timezone, and session info. Use this when you need to know the current time or date for scheduling, reminders, or time-based decisions.",
    inputSchema: {},
  }, async () => {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return {
      content: [{ type: "text", text: JSON.stringify({
        time: now.toISOString(),
        localTime: now.toLocaleString("en-SE", { timeZone: tz }),
        timezone: tz,
        dayOfWeek: now.toLocaleDateString("en-US", { weekday: "long" }),
      }) }],
    };
  });

  server.registerTool("manage_jobs", {
    description:
      "Manage scheduled reminders and jobs for a user. Use 'list' to see jobs, 'add' to create, 'remove' to delete by id.",
    inputSchema: {
      action: z.enum(["list", "add", "remove"]).describe("The action to perform"),
      userName: z.string().describe("The user name"),
      job: z.object({
        id: z.string(),
        name: z.string(),
        prompt: z.string(),
        cron: z.string().optional(),
        at: z.string().optional(),
        timezone: z.string().optional(),
      }).optional().describe("Job to add (required for 'add' action)"),
      id: z.string().optional().describe("Job id to remove (required for 'remove' action)"),
    },
  }, async ({ action, userName, job, id }) => {
    const user = toUserSlug(userName);

    if (action === "list") {
      const jobs = loadUserJobs(user);
      return { content: [{ type: "text", text: JSON.stringify(jobs, null, 2) }] };
    }

    if (action === "add" && job) {
      // Upsert: replace existing job with same ID, or append
      let jobs = loadUserJobs(user);
      jobs = jobs.filter((j) => j.id !== job.id);
      jobs.push(job);
      saveUserJobs(user, jobs);
      return { content: [{ type: "text", text: `Job "${job.name}" added` }] };
    }

    if (action === "remove" && id) {
      const jobs = loadUserJobs(user);
      const filtered = jobs.filter((j) => j.id !== id);
      saveUserJobs(user, filtered);
      return { content: [{ type: "text", text: filtered.length < jobs.length ? `Job "${id}" removed` : `Job "${id}" not found` }] };
    }

    return { content: [{ type: "text", text: "Invalid action or missing parameters" }], isError: true };
  });

  server.registerTool("get_secret_url", {
    description:
      "Get the URL of the secret manager web UI. Use this when you need to direct a user to add or manage their API keys/credentials.",
    inputSchema: {},
  }, async () => {
    return {
      content: [{ type: "text", text: getBaseUrl() }],
    };
  });

  server.registerTool("run_script", {
    description:
      "Run a script from the project's scripts/ directory or a skill's scripts/ directory. Only pre-defined scripts can be executed. Credentials are injected automatically from the vault.",
    inputSchema: {
      script: z.string().describe("Absolute path to the script file"),
      args: z.array(z.string()).optional().describe("Arguments to pass to the script"),
    },
  }, async ({ script, args }) => {
    const userName = args?.[0] ? toUserSlug(args[0]) : "";

    // Normalize script path: OpenCode sends paths relative to its container
    // (e.g. "skills/withings/scripts/setup.sh" or "/data/skills/withings/scripts/setup.sh")
    // Skills are shared at /data/skills/
    let scriptPath = script;
    const skillsMatch = script.match(/(?:^|\/)(skills\/.+)$/);
    if (skillsMatch) {
      scriptPath = join(dataDir, skillsMatch[1]);
    }

    const resolved = resolve(scriptPath);
    if (!projectScripts.has(resolved) && !isSkillScript(resolved, dataDir)) {
      return {
        content: [{ type: "text", text: `Error: Script not allowed. Must be in project scripts/ or skills/*/scripts/.` }],
        isError: true,
      };
    }

    if (!existsSync(resolved)) {
      return {
        content: [{ type: "text", text: `Error: Script not found: ${script}` }],
        isError: true,
      };
    }

    const skill = getSkillFromPath(resolved);
    const scriptContext = buildScriptExecutionContext({
      vault,
      userName,
      scriptPath: resolved,
      dataDir,
      projectRoot,
      fallbackSkillName: skill,
    });

    if (!scriptContext.usedManifest && skill) {
      console.warn(`run_script fallback secret injection used for ${skill}/${basename(resolved)}`);
    }

    return new Promise((res) => {
      const startedAt = Date.now();
      execFile("bash", [resolved, ...(args || [])], {
        timeout: 300_000,
        env: {
          ...process.env,
          STEVE_PROJECT_ROOT: projectRoot,
          STEVE_DATA_DIR: dataDir,
          STEVE_BASE_URL: getBaseUrl(),
          ...scriptContext.env,
        },
      }, (error, stdout, stderr) => {
        let output = stdout || "(no output)";
        try {
          const parsed = JSON.parse(output);
          if (parsed.save_to_vault && vault) {
            const { key, value } = parsed.save_to_vault;
            if (key && value) vault.set(key, value);
            delete parsed.save_to_vault;
            output = JSON.stringify(parsed);
          }
        } catch {}

        const redactedOutput = redactSecrets(output, scriptContext.injectedSecretValues);
        const redactedError = redactSecrets(stderr || "", scriptContext.injectedSecretValues);
        const safeOutput = redactedOutput.text;
        const safeError = redactedError.text;
        const auditEntry = {
          timestamp: new Date().toISOString(),
          userName,
          script: resolved,
          status: error ? "error" as const : "ok" as const,
          durationMs: Date.now() - startedAt,
          secretKeys: scriptContext.injectedSecretKeys,
          usedManifest: scriptContext.usedManifest,
          redactionCount: redactedOutput.redactionCount + redactedError.redactionCount,
        };
        appendRunScriptAudit(dataDir, auditEntry);

        if (error) {
          res({
            content: [{ type: "text", text: safeError || safeOutput || error.message }],
            isError: true,
          });
          return;
        }

        res({
          content: [{ type: "text", text: safeOutput }],
        });
      });
    });
  });

  return server;
  };
}
