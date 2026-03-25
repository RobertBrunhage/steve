import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Vault } from "../vault/index.js";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
  });
}

/**
 * Start the MCP server as an HTTP endpoint with an internal vault API.
 * OpenCode connects to MCP. Scripts call /vault/* to store secrets.
 */
export async function startMcpHttpServer(
  mcpServer: McpServer,
  vault: Vault | null,
  port: number,
): Promise<Server> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  await mcpServer.connect(transport);

  const httpServer = createServer(async (req, res) => {
    // Internal vault API (only accessible on Docker network, port not exposed to host)
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
    transport.handleRequest(req, res);
  });

  return new Promise((resolve) => {
    httpServer.listen(port, "0.0.0.0", () => {
      resolve(httpServer);
    });
  });
}
