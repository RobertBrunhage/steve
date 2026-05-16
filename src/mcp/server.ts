import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { APP_NAME, APP_SLUG } from "../brand.js";
import { appendUserActivity } from "../activity.js";
import { getBrowserService } from "../browser/index.js";
import type { BrowserTarget } from "../browser/types.js";
import type { Vault } from "../vault/index.js";
import type { Channel } from "../channels/index.js";
import { config, getBaseUrl, getSystemTimezone } from "../config.js";
import { loadUserAgentJobs, loadUserJobs, removeUserJob, type Job, upsertUserJob } from "../scheduler.js";
import { toUserSlug } from "../users.js";
import {
  deleteWorkflow,
  listInstances,
  listWorkflows,
  readInstance,
  readWorkflow,
  writeWorkflow,
} from "../workflows/storage.js";
import { validateWorkflowYaml, type WorkflowRunner } from "../workflows/runner.js";
import { parseWorkflow } from "../workflows/parser.js";
import { discoverProjectScripts, executeAllowedScript, resolveAllowedScript } from "./script-exec.js";

interface McpConfig {
  channel: Channel;
  projectRoot: string;
  dataDir: string;
  engine?: WorkflowRunner;
}

export type McpServerFactory = () => McpServer;

export function createMcpServerFactory(mcpConfig: McpConfig, vault: Vault | null): McpServerFactory {
  const { channel, projectRoot, dataDir } = mcpConfig;
  const projectScripts = discoverProjectScripts(projectRoot);
  const browser = getBrowserService();

  return () => {
  const server = new McpServer({
    name: APP_SLUG,
    version: "1.0.0",
  });

  server.registerTool("send_message", {
    description:
      "Send a message to a user. Use this to respond to users. This is the ONLY way to communicate with users.",
    inputSchema: {
      userName: z.string().describe("The name of the user to send the message to"),
      agentId: z.string().optional().describe("Optional Kellix agent id. Use the current agent id when available."),
      message: z.string().describe("The message text to send (supports HTML)"),
      buttons: z.array(z.array(z.string())).optional().describe("Optional inline button rows, e.g. [['Yes','No']]"),
    },
  }, async ({ userName, agentId, message, buttons }) => {
    const result = await channel.sendMessage(userName, message, { ...(buttons ? { buttons } : {}), ...(agentId ? { agentId } : {}) });
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
      agentId: z.string().optional().describe("Optional Kellix agent id. Use the current agent id when available."),
      filePath: z.string().describe("Absolute local path to the file"),
      caption: z.string().optional().describe("Optional caption to include with the file"),
    },
  }, async ({ userName, agentId, filePath, caption }) => {
    const result = await channel.sendFile(userName, filePath, caption, agentId ? { agentId } : undefined);
    if (!result.ok) {
      return {
        content: [{ type: "text", text: `Error: ${result.error || "unknown error"}` }],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: `File sent to ${userName}` }] };
  });

  const browserTargetSchema = z.enum(["container", "remote"]).optional().describe("Optional browser target. Defaults to Kellix's configured browser target.");

  server.registerTool("browser_open", {
    description: "Open a URL in the current user's Kellix browser profile. Returns a compact page snapshot. `viewerUrl` is only present for the container browser; attached remote Chrome does not return one.",
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
      "Manage scheduled reminders and jobs for the calling agent. Use 'list' to see jobs, 'add' to create, 'remove' to delete by id. Pass agentId so jobs scope to your agent.",
    inputSchema: {
      action: z.enum(["list", "add", "remove"]).describe("The action to perform"),
      userName: z.string().describe("The user name"),
      agentId: z.string().optional().describe("Calling agent id. Required for agent-scoped routing."),
      job: z.object({
        id: z.string(),
        agentId: z.string().optional().describe("Optional Kellix agent id. Defaults to top-level agentId or kellix."),
        name: z.string(),
        prompt: z.string(),
        cron: z.string().optional(),
        at: z.string().optional(),
        timezone: z.string().optional(),
      }).optional().describe("Job to add (required for 'add' action)"),
      id: z.string().optional().describe("Job id to remove (required for 'remove' action)"),
    },
  }, async ({ action, userName, agentId, job, id }) => {
    const user = toUserSlug(userName);
    const callerAgentId = agentId ? toUserSlug(agentId) : undefined;

    if (action === "list") {
      const jobs = callerAgentId ? loadUserAgentJobs(user, callerAgentId) : loadUserJobs(user);
      return { content: [{ type: "text", text: JSON.stringify(jobs, null, 2) }] };
    }

    if (action === "add" && job) {
      const scopedAgentId = job.agentId || callerAgentId || APP_SLUG;
      upsertUserJob(user, { ...job, agentId: scopedAgentId });
      return { content: [{ type: "text", text: `Job "${job.name}" added` }] };
    }

    if (action === "remove" && id) {
      const removed = removeUserJob(user, id, callerAgentId);
      return { content: [{ type: "text", text: removed ? `Job "${id}" removed` : `Job "${id}" not found` }] };
    }

    return { content: [{ type: "text", text: "Invalid action or missing parameters" }], isError: true };
  });

  server.registerTool("manage_workflows", {
    description:
      "Define and run Kellix workflows for the calling agent. Workflows are YAML files in agents/<id>/workflows/ that orchestrate shell, llm, approval, sub-workflow, and cross_agent steps. Validate yaml before defining; pass agentId to scope to the calling agent.",
    inputSchema: {
      action: z.enum(["list", "view", "run", "cancel", "resume", "validate", "define", "delete"]).describe("Action to perform"),
      userName: z.string().describe("User the workflow belongs to"),
      agentId: z.string().optional().describe("Agent id. Defaults to the user's kellix agent."),
      name: z.string().optional().describe("Workflow name (for view/run/validate/define/delete)"),
      yaml: z.string().optional().describe("Workflow YAML content (for validate/define)"),
      args: z.record(z.string(), z.any()).optional().describe("Args to pass when running (for run)"),
      instanceId: z.string().optional().describe("Instance id (for view/cancel/resume)"),
      response: z.string().optional().describe("Approval response text (for resume)"),
      approvedBy: z.string().optional().describe("Identity of approver (for resume)"),
    },
  }, async ({ action, userName, agentId, name, yaml: yamlText, args, instanceId, response, approvedBy }) => {
    const user = toUserSlug(userName);
    const agent = toUserSlug(agentId || APP_SLUG);
    const engine = mcpConfig.engine;

    if (action === "validate") {
      if (!yamlText) return { content: [{ type: "text", text: "yaml is required for validate" }], isError: true };
      const result = validateWorkflowYaml(yamlText);
      const errorLines = result.errors.map((e) => {
        const loc = e.line ? ` (line ${e.line}${e.column ? `, col ${e.column}` : ""})` : "";
        const path = e.path ? ` [${e.path}]` : "";
        return `  - ${e.severity ?? "error"}${loc}${path}: ${e.message}`;
      });
      const text = result.ok
        ? errorLines.length > 0
          ? `valid (with ${errorLines.length} warnings):\n${errorLines.join("\n")}`
          : "valid"
        : `invalid:\n${errorLines.join("\n")}`;
      return { content: [{ type: "text", text }] };
    }

    if (action === "list") {
      const defs = listWorkflows(user, agent).map((d) => ({
        name: d.name,
        description: d.description,
        triggers: d.triggers,
        stepCount: d.steps.length,
      }));
      const runs = listInstances(user, agent, { limit: 20 }).map((i) => ({
        id: i.id,
        workflowName: i.workflowName,
        status: i.status,
        startedAt: i.startedAt,
        finishedAt: i.finishedAt,
        currentStepId: i.currentStepId,
      }));
      return { content: [{ type: "text", text: JSON.stringify({ workflows: defs, runs }, null, 2) }] };
    }

    if (action === "view") {
      if (instanceId) {
        const inst = readInstance(user, agent, instanceId);
        if (!inst) return { content: [{ type: "text", text: `instance ${instanceId} not found` }], isError: true };
        return { content: [{ type: "text", text: JSON.stringify(inst, null, 2) }] };
      }
      if (name) {
        const def = readWorkflow(user, agent, name);
        if (!def) return { content: [{ type: "text", text: `workflow ${name} not found` }], isError: true };
        return { content: [{ type: "text", text: JSON.stringify(def, null, 2) }] };
      }
      return { content: [{ type: "text", text: "view requires name or instanceId" }], isError: true };
    }

    if (action === "define") {
      if (!name || !yamlText) return { content: [{ type: "text", text: "define requires name and yaml" }], isError: true };
      const result = parseWorkflow(yamlText);
      const fatal = result.errors.filter((e) => e.severity !== "warning");
      if (fatal.length > 0) {
        const lines = fatal.map((e) => {
          const loc = e.line ? ` (line ${e.line}${e.column ? `, col ${e.column}` : ""})` : "";
          return `  - ${loc} ${e.message}`;
        });
        return { content: [{ type: "text", text: `invalid yaml, refusing to write:\n${lines.join("\n")}` }], isError: true };
      }
      const path = writeWorkflow(user, agent, name, yamlText);
      return { content: [{ type: "text", text: `defined: ${path}` }] };
    }

    if (action === "delete") {
      if (!name) return { content: [{ type: "text", text: "delete requires name" }], isError: true };
      const removed = deleteWorkflow(user, agent, name);
      return { content: [{ type: "text", text: removed ? `deleted ${name}` : `${name} not found` }] };
    }

    if (action === "run") {
      if (!engine) return { content: [{ type: "text", text: "workflow engine not available" }], isError: true };
      if (!name) return { content: [{ type: "text", text: "run requires name" }], isError: true };
      try {
        const inst = await engine.runByName(user, agent, name, { args, triggerKind: "manual" });
        return { content: [{ type: "text", text: JSON.stringify({ instanceId: inst.id, status: inst.status, output: inst.output }, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
      }
    }

    if (action === "resume") {
      if (!engine) return { content: [{ type: "text", text: "workflow engine not available" }], isError: true };
      if (!instanceId) return { content: [{ type: "text", text: "resume requires instanceId" }], isError: true };
      const ok = engine.resume({ instanceId, response, approvedBy });
      return { content: [{ type: "text", text: ok ? "resumed" : "no waiting approval for that instance" }], isError: !ok };
    }

    if (action === "cancel") {
      if (!engine) return { content: [{ type: "text", text: "workflow engine not available" }], isError: true };
      if (!instanceId) return { content: [{ type: "text", text: "cancel requires instanceId" }], isError: true };
      engine.cancel(instanceId);
      return { content: [{ type: "text", text: "cancel requested" }] };
    }

    return { content: [{ type: "text", text: "unknown action" }], isError: true };
  });

  server.registerTool("get_secret_url", {
    description:
      "Get the URL where a user can add or manage secrets. Prefer passing the current userName so Kellix links directly to that user's integrations.",
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
      agentId: z.string().optional().describe("Optional Kellix agent id. Defaults to the user's default kellix agent."),
      args: z.array(z.string()).optional().describe("Arguments to pass to the script"),
    },
  }, async ({ script, agentId, args }) => {
    const userName = args?.[0] ? toUserSlug(args[0]) : "";
    const scriptArgs = userName && args?.length
      ? [userName, ...args.slice(1)]
      : (args || []);

    const resolution = resolveAllowedScript({ script, userName, agentId, dataDir, projectScripts });
    if (!resolution.ok) {
      return { content: [{ type: "text", text: `Error: ${resolution.error}` }], isError: true };
    }

    const result = await executeAllowedScript({
      resolved: resolution.resolved,
      args: scriptArgs,
      userName,
      vault,
      dataDir,
      projectRoot,
      skill: resolution.skill,
    });

    if (result.exitCode !== 0) {
      return {
        content: [{ type: "text", text: result.stderr || result.stdout || `script exited with code ${result.exitCode}` }],
        isError: true,
      };
    }
    return { content: [{ type: "text", text: result.stdout || "(no output)" }] };
  });

  return server;
  };
}
