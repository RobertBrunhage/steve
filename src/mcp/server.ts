import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve, normalize, basename, dirname } from "node:path";
import { execFile } from "node:child_process";
import { z } from "zod";
import { appendUserActivity } from "../activity.js";
import { getBrowserService } from "../browser/index.js";
import type { BrowserTarget } from "../browser/types.js";
import type { Vault } from "../vault/index.js";
import type { Channel } from "../channels/index.js";
import { config, getBaseUrl, getSystemTimezone } from "../config.js";
import { loadUserJobs, removeUserJob, type Job, upsertUserJob } from "../scheduler.js";
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

/** Check if a script is inside a user's skills/scripts/ directory */
function isSkillScript(scriptPath: string, dataDir: string): boolean {
  const resolved = resolve(scriptPath);

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
  const browser = getBrowserService();

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
      appendUserActivity(config.dataDir, {
        timestamp: new Date().toISOString(),
        userName,
        type: "message_sent",
        status: "error",
        summary: `Failed to send message${result.error ? `: ${result.error}` : ""}`,
      });
      return {
        content: [{ type: "text", text: `Error: ${result.error || "unknown error"}` }],
        isError: true,
      };
    }

    console.log(`send_message delivered for ${userName}`);
    appendUserActivity(config.dataDir, {
      timestamp: new Date().toISOString(),
      userName,
      type: "message_sent",
      status: "ok",
      summary: `Sent message: ${message.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "(empty message)"}`,
    });

    return {
      content: [{ type: "text", text: `Message sent to ${userName}` }],
    };
  });

  server.registerTool("send_file", {
    description:
      "Send a local file to a user, such as a browser screenshot or downloaded document.",
    inputSchema: {
      userName: z.string().describe("The name of the user to send the file to"),
      filePath: z.string().describe("Absolute local path to the file"),
      caption: z.string().optional().describe("Optional caption to include with the file"),
    },
  }, async ({ userName, filePath, caption }) => {
    const result = await channel.sendFile(userName, filePath, caption);
    if (!result.ok) {
      return {
        content: [{ type: "text", text: `Error: ${result.error || "unknown error"}` }],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: `File sent to ${userName}` }] };
  });

  const browserTargetSchema = z.enum(["container", "remote"]).optional().describe("Optional browser target. Defaults to Steve's configured browser target.");

  server.registerTool("browser_open", {
    description: "Open a URL in the current user's Steve browser profile. Returns a compact page snapshot. `viewerUrl` is only present for the container browser; attached remote Chrome does not return one.",
    inputSchema: {
      userName: z.string().describe("The current user name"),
      url: z.string().describe("The URL to open"),
      target: browserTargetSchema,
    },
  }, async ({ userName, url, target }) => ({ content: [{ type: "text", text: JSON.stringify(await browser.open({ userName, url, target: target as BrowserTarget | undefined })) }] }));

  server.registerTool("browser_snapshot", {
    description: "Get a compact structured snapshot of the current browser page, including page text and interactive elements. `viewerUrl` is only present for the container browser; attached remote Chrome does not return one.",
    inputSchema: {
      userName: z.string().describe("The current user name"),
      target: browserTargetSchema,
    },
  }, async ({ userName, target }) => ({ content: [{ type: "text", text: JSON.stringify(await browser.snapshot({ userName, target: target as BrowserTarget | undefined })) }] }));

  server.registerTool("browser_click", {
    description: "Click an interactive browser element by ref from the latest browser snapshot.",
    inputSchema: {
      userName: z.string().describe("The current user name"),
      ref: z.string().describe("Element ref from browser_snapshot"),
      target: browserTargetSchema,
    },
  }, async ({ userName, ref, target }) => ({ content: [{ type: "text", text: JSON.stringify(await browser.click({ userName, ref, target: target as BrowserTarget | undefined })) }] }));

  server.registerTool("browser_type", {
    description: "Type into an interactive browser element by ref from the latest browser snapshot.",
    inputSchema: {
      userName: z.string().describe("The current user name"),
      ref: z.string().describe("Element ref from browser_snapshot"),
      text: z.string().describe("Text to type"),
      submit: z.boolean().optional().describe("Press Enter after typing"),
      target: browserTargetSchema,
    },
  }, async ({ userName, ref, text, submit, target }) => ({ content: [{ type: "text", text: JSON.stringify(await browser.type({ userName, ref, text, submit, target: target as BrowserTarget | undefined })) }] }));

  server.registerTool("browser_wait", {
    description: "Wait for text or an element ref to become ready in the current browser page.",
    inputSchema: {
      userName: z.string().describe("The current user name"),
      text: z.string().optional().describe("Visible text to wait for"),
      ref: z.string().optional().describe("Element ref to wait for"),
      timeoutMs: z.number().optional().describe("Optional timeout in milliseconds"),
      target: browserTargetSchema,
    },
  }, async ({ userName, text, ref, timeoutMs, target }) => ({ content: [{ type: "text", text: JSON.stringify(await browser.wait({ userName, text, ref, timeoutMs, target: target as BrowserTarget | undefined })) }] }));

  server.registerTool("browser_screenshot", {
    description: "Take a screenshot of the current browser page. Returns the saved file path and, for the container browser only, a viewer URL.",
    inputSchema: {
      userName: z.string().describe("The current user name"),
      fullPage: z.boolean().optional().describe("Capture the full page instead of only the viewport"),
      target: browserTargetSchema,
    },
  }, async ({ userName, fullPage, target }) => ({ content: [{ type: "text", text: JSON.stringify(await browser.screenshot({ userName, fullPage, target: target as BrowserTarget | undefined })) }] }));

  server.registerTool("browser_download", {
    description: "Click an element by ref and wait for a file download. Returns the saved download path and, for the container browser only, a viewer URL.",
    inputSchema: {
      userName: z.string().describe("The current user name"),
      ref: z.string().describe("Element ref from browser_snapshot"),
      target: browserTargetSchema,
    },
  }, async ({ userName, ref, target }) => ({ content: [{ type: "text", text: JSON.stringify(await browser.download({ userName, ref, target: target as BrowserTarget | undefined })) }] }));

  server.registerTool("session_status", {
    description:
      "Get the current time, timezone, and session info. Use this when you need to know the current time or date for scheduling, reminders, or time-based decisions.",
    inputSchema: {},
  }, async () => {
    const now = new Date();
    const tz = getSystemTimezone();
    return {
      content: [{ type: "text", text: JSON.stringify({
        time: now.toISOString(),
        localTime: now.toLocaleString("en-SE", { timeZone: tz }),
        timezone: tz,
        dayOfWeek: now.toLocaleDateString("en-US", { weekday: "long", timeZone: tz }),
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
      upsertUserJob(user, job);
      return { content: [{ type: "text", text: `Job "${job.name}" added` }] };
    }

    if (action === "remove" && id) {
      const removed = removeUserJob(user, id);
      return { content: [{ type: "text", text: removed ? `Job "${id}" removed` : `Job "${id}" not found` }] };
    }

    return { content: [{ type: "text", text: "Invalid action or missing parameters" }], isError: true };
  });

  server.registerTool("get_secret_url", {
    description:
      "Get the URL where a user can add or manage secrets. Prefer passing the current userName so Steve links directly to that user's integrations.",
    inputSchema: {
      userName: z.string().optional().describe("Optional current user name to link directly to that user's integrations page"),
      integration: z.string().optional().describe("Optional integration name; currently used only for better instructions alongside the returned URL"),
    },
  }, async ({ userName, integration }) => {
    const targetUser = userName ? toUserSlug(userName) : "";
    const targetIntegration = integration ? toUserSlug(integration) : "";
    const targetUrl = targetUser
      ? targetIntegration
        ? `${getBaseUrl()}/users/${encodeURIComponent(targetUser)}/integrations/new?integration=${encodeURIComponent(targetIntegration)}`
        : `${getBaseUrl()}/users/${encodeURIComponent(targetUser)}/integrations`
      : `${getBaseUrl()}/settings`;
    return {
      content: [{ type: "text", text: targetUrl }],
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
    const scriptArgs = userName && args?.length
      ? [userName, ...args.slice(1)]
      : (args || []);

    // Normalize script path: OpenCode sends paths relative to its container
    // (e.g. "skills/withings/scripts/setup.sh" or "/data/skills/withings/scripts/setup.sh").
    // User skills live under that user's workspace at users/<user>/skills on the host.
    let scriptPath = script;
    const skillsMatch = script.match(/(?:^|\/)(skills\/.+)$/);
    if (skillsMatch) {
      if (!userName) {
        return {
          content: [{ type: "text", text: "Error: Skill scripts require the current user name as the first argument." }],
          isError: true,
        };
      }
      scriptPath = join(dataDir, "users", userName, skillsMatch[1]);
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
    });

    return new Promise((res) => {
      const startedAt = Date.now();
      execFile("bash", [resolved, ...scriptArgs], {
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

        const redactedOutput = scriptContext.redactOutput
          ? redactSecrets(output, scriptContext.injectedSecretValues)
          : { text: output, redactionCount: 0 };
        const redactedError = scriptContext.redactOutput
          ? redactSecrets(stderr || "", scriptContext.injectedSecretValues)
          : { text: stderr || "", redactionCount: 0 };
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
        appendUserActivity(config.dataDir, {
          timestamp: auditEntry.timestamp,
          userName: userName || "system",
          type: "script",
          status: error ? "error" : "ok",
          summary: `${error ? "Script failed" : "Script ran"}: ${skill ? `${skill}/` : ""}${basename(resolved)}`,
        });

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
