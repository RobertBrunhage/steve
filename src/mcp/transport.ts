import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Vault } from "../vault/index.js";
import type { McpServerFactory } from "./server.js";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
  });
}

/**
 * Start the MCP server as an HTTP endpoint with an internal vault API.
 * Supports multiple concurrent MCP clients (one per OpenCode container).
 */
export async function startMcpHttpServer(
  mcpFactory: McpServerFactory,
  vault: Vault | null,
  port: number,
): Promise<Server> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req, res) => {
    // Internal vault API
    if (req.url === "/vault/set" && req.method === "POST") {
      if (!vault) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "vault not available" }));
        return;
      }
      try {
        const body = JSON.parse(await readBody(req));
        if (!body.key || !body.value) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "key and value required" }));
          return;
        }
        vault.set(body.key, body.value);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON" }));
      }
      return;
    }

    if (req.url === "/vault/get" && req.method === "POST") {
      if (!vault) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "vault not available" }));
        return;
      }
      try {
        const body = JSON.parse(await readBody(req));
        if (!body.key) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "key required" }));
          return;
        }
        const value = vault.get(body.key);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ value }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON" }));
      }
      return;
    }

    // MCP protocol handler
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    // Existing session — route to its transport
    if (sessionId && sessions.has(sessionId)) {
      const transport = sessions.get(sessionId)!;
      await transport.handleRequest(req, res);
      return;
    }

    // Stale session
    if (sessionId && !sessions.has(sessionId)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Session not found" }, id: null }));
      return;
    }

    // New connection — peek at the body to check if it's an initialize request
    const bodyText = await readBody(req);
    let body: any;
    try {
      body = JSON.parse(bodyText);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
      return;
    }

    if (!isInitializeRequest(body)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message: "First request must be initialize" }, id: null }));
      return;
    }

    // Create a new transport for this client
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => {
        const id = randomUUID();
        sessions.set(id, transport);
        return id;
      },
    });

    transport.onclose = () => {
      for (const [id, t] of sessions) {
        if (t === transport) {
          sessions.delete(id);
          break;
        }
      }
    };

    const mcpServer = mcpFactory();
    await mcpServer.connect(transport);

    // Re-inject the body since we already consumed it
    await transport.handleRequest(req, res, body);
  });

  return new Promise((resolve) => {
    httpServer.listen(port, "0.0.0.0", () => {
      resolve(httpServer);
    });
  });
}
