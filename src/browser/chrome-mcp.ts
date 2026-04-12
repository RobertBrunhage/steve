import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AttachedBrowserConfig } from "./types.js";

interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ChromeMcpSnapshot {
  url: string;
  title: string;
  text: string;
  elements: Array<{ ref: string; role: string; name: string }>;
}

const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "menuitem",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

function extractText(result: ToolResult): string {
  return (result.content || [])
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text || "")
    .join("\n")
    .trim();
}

function unwrapJsonText(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  return text.trim();
}

function extractStructuredValue(result: ToolResult): unknown {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    if ("result" in result.structuredContent) return result.structuredContent.result;
    if ("value" in result.structuredContent) return result.structuredContent.value;
    return result.structuredContent;
  }
  const text = unwrapJsonText(extractText(result));
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const result = await client.callTool({ name, arguments: args }) as ToolResult;
  if (result.isError) {
    throw new Error(extractText(result) || `Chrome MCP tool ${name} failed`);
  }
  return result;
}

export function parseSnapshotText(snapshotText: string): Array<{ ref: string; role: string; name: string }> {
  const elements: Array<{ ref: string; role: string; name: string }> = [];
  for (const line of snapshotText.split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = trimmed.match(/^uid=([^\s]+)\s+([^\s]+)(?:\s+"([^"]*)")?/);
    if (!match) continue;
    const [, ref, role, rawName] = match;
    if (!INTERACTIVE_ROLES.has(role)) continue;
    elements.push({ ref, role, name: (rawName || role).slice(0, 120) });
  }
  return elements;
}

export class ChromeMcpBrowserSession {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private hasOwnedPage = false;

  constructor(private readonly attach: AttachedBrowserConfig) {}

  private async ensureClient(): Promise<Client> {
    if (this.client) return this.client;
    const args = [
      "-y",
      "chrome-devtools-mcp@latest",
      "--autoConnect",
      `--channel=${this.attach.channel}`,
      "--no-usage-statistics",
      "--no-performance-crux",
    ];
    const transport = new StdioClientTransport({
      command: "npx",
      args,
      env: {
        ...process.env,
        CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
        CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
      } as Record<string, string>,
      stderr: "pipe",
    });
    const client = new Client({ name: "kellix-remote-browser", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    this.transport = transport;
    this.client = client;
    return client;
  }

  private async evaluateMeta(): Promise<{ url: string; title: string; text: string }> {
    const client = await this.ensureClient();
    const result = await callTool(client, "evaluate_script", {
      function: `() => ({
        url: window.location.href,
        title: document.title,
        text: (document.body?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 5000)
      })`,
    });
    const value = extractStructuredValue(result) as Record<string, unknown> | null;
    return {
      url: typeof value?.url === "string" ? value.url : "",
      title: typeof value?.title === "string" ? value.title : "",
      text: typeof value?.text === "string" ? value.text : "",
    };
  }

  async open(url: string): Promise<void> {
    const client = await this.ensureClient();
    if (!this.hasOwnedPage) {
      await callTool(client, "new_page", { url });
      this.hasOwnedPage = true;
      return;
    }
    await callTool(client, "navigate_page", { type: "url", url });
  }

  async snapshot(): Promise<ChromeMcpSnapshot> {
    const client = await this.ensureClient();
    const [meta, snapshotResult] = await Promise.all([
      this.evaluateMeta(),
      callTool(client, "take_snapshot"),
    ]);
    const snapshotText = extractText(snapshotResult);
    return {
      ...meta,
      elements: parseSnapshotText(snapshotText),
    };
  }

  async click(ref: string): Promise<void> {
    const client = await this.ensureClient();
    await callTool(client, "click", { uid: ref });
  }

  async type(ref: string, text: string, submit?: boolean): Promise<void> {
    const client = await this.ensureClient();
    await callTool(client, "fill", { uid: ref, value: text });
    if (submit) {
      await callTool(client, "press_key", { key: "Enter" });
    }
  }

  async wait(input: { text?: string; ref?: string; timeoutMs?: number }): Promise<void> {
    const timeoutMs = input.timeoutMs || 15000;
    if (input.text) {
      const client = await this.ensureClient();
      await callTool(client, "wait_for", { text: [input.text], timeout: timeoutMs });
      return;
    }
    if (input.ref) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const snapshot = await this.snapshot();
        if (snapshot.elements.some((element) => element.ref === input.ref)) return;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      throw new Error(`Timed out waiting for ${input.ref}`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 1000)));
  }

  async screenshot(filePath: string, fullPage = true): Promise<void> {
    const client = await this.ensureClient();
    await callTool(client, "take_screenshot", { filePath, format: "png", fullPage });
  }

  async download(): Promise<never> {
    throw new Error("Downloads are not supported for attached Chrome sessions yet. Download the file manually in Chrome or use the container browser.");
  }

  async close(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    this.hasOwnedPage = false;
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
  }
}
