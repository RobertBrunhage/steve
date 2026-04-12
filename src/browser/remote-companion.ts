import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readEnv } from "../brand.js";
import { ChromeMcpBrowserSession } from "./chrome-mcp.js";
import { getTimestamp, looksLikeAuthRequired } from "./common.js";
import { toUserSlug } from "../users.js";
import type { AttachedBrowserConfig, BrowserActionResult } from "./types.js";

const PORT = Number(readEnv("KELLIX_REMOTE_BROWSER_PORT", "STEVE_REMOTE_BROWSER_PORT")) || 4782;
const ROOT = readEnv("KELLIX_REMOTE_BROWSER_ROOT", "STEVE_REMOTE_BROWSER_ROOT") || join(process.env.HOME || process.cwd(), ".kellix", "remote-browser");
const CONTAINER_ROOT = readEnv("KELLIX_REMOTE_BROWSER_CONTAINER_ROOT", "STEVE_REMOTE_BROWSER_CONTAINER_ROOT") || "";

const sessions = new Map<string, ChromeMcpBrowserSession>();
const sessionPromises = new Map<string, Promise<ChromeMcpBrowserSession>>();
const sessionConfigKeys = new Map<string, string>();

function getUserRoot(userName: string) {
  return join(ROOT, userName);
}

function getScreenshotsDir(userName: string) {
  return join(getUserRoot(userName), "screenshots");
}

function ensureDirs(userName: string) {
  mkdirSync(getScreenshotsDir(userName), { recursive: true });
}

function toContainerPath(filePath: string): string {
  if (!CONTAINER_ROOT) return filePath;
  if (!filePath.startsWith(ROOT)) return filePath;
  return `${CONTAINER_ROOT}${filePath.slice(ROOT.length)}`;
}

function normalizeUserName(input: string): string {
  return toUserSlug(decodeURIComponent(input).replace(/[*_`]+$/g, "").trim());
}

function parseAttach(value: unknown): AttachedBrowserConfig | null {
  if (!value || typeof value !== "object") return null;
  const attach = value as Partial<AttachedBrowserConfig>;
  if (attach.mode !== "local_chrome") return null;
  return {
    mode: "local_chrome",
    channel: attach.channel === "beta" || attach.channel === "dev" || attach.channel === "canary" ? attach.channel : "stable",
    updatedAt: typeof attach.updatedAt === "string" ? attach.updatedAt : new Date().toISOString(),
    lastConnectedAt: typeof attach.lastConnectedAt === "string" ? attach.lastConnectedAt : null,
    lastError: typeof attach.lastError === "string" ? attach.lastError : null,
  };
}

async function parseJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

function sendJson(res: ServerResponse, payload: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function createSession(userName: string, attach: AttachedBrowserConfig): Promise<ChromeMcpBrowserSession> {
  const session = new ChromeMcpBrowserSession(attach);
  sessions.set(userName, session);
  sessionConfigKeys.set(userName, JSON.stringify({ mode: attach.mode, channel: attach.channel }));
  return session;
}

async function ensureSession(userName: string, attach: AttachedBrowserConfig): Promise<ChromeMcpBrowserSession> {
  const attachKey = JSON.stringify({ mode: attach.mode, channel: attach.channel });
  const existing = sessions.get(userName);
  if (existing && sessionConfigKeys.get(userName) === attachKey) return existing;
  if (existing) {
    sessions.delete(userName);
    sessionConfigKeys.delete(userName);
    await existing.close().catch(() => {});
  }
  const pending = sessionPromises.get(userName);
  if (pending) return pending;
  const promise = createSession(userName, attach).finally(() => {
    sessionPromises.delete(userName);
  });
  sessionPromises.set(userName, promise);
  return promise;
}

function toResult(snapshot: { url: string; title: string; text: string; elements: Array<{ ref: string; role: string; name: string }> }, message?: string): BrowserActionResult {
  const status = looksLikeAuthRequired(snapshot.url, snapshot.text) ? "auth_required" : "ok";
  return {
    ok: true,
    status,
    url: snapshot.url,
    title: snapshot.title,
    text: snapshot.text,
    elements: snapshot.elements,
    message: message || (status === "auth_required"
      ? "Continue in your attached Chrome window, then tell Kellix when you are done."
      : undefined),
  };
}

async function handleApi(req: IncomingMessage, res: ServerResponse, path: string) {
  const body = await parseJson(req) as Record<string, unknown>;
  const userName = typeof body.userName === "string" ? normalizeUserName(body.userName) : "";
  const attach = parseAttach(body.attach);
  if (!userName) return sendJson(res, { ok: false, status: "error", error: "userName required" }, 400);
  if (!attach) return sendJson(res, { ok: false, status: "error", error: "attach config required" }, 400);

  try {
    ensureDirs(userName);
    const session = await ensureSession(userName, attach);

    if (path === "/api/session/open") {
      const url = typeof body.url === "string" ? body.url : "";
      if (!url) return sendJson(res, { ok: false, status: "error", error: "url required" }, 400);
      await session.open(url);
      return sendJson(res, toResult(await session.snapshot(), `Opened ${url}`));
    }
    if (path === "/api/session/snapshot") {
      return sendJson(res, toResult(await session.snapshot()));
    }
    if (path === "/api/session/click") {
      const ref = typeof body.ref === "string" ? body.ref : "";
      if (!ref) return sendJson(res, { ok: false, status: "error", error: "ref required" }, 400);
      await session.click(ref);
      return sendJson(res, toResult(await session.snapshot(), `Clicked ${ref}`));
    }
    if (path === "/api/session/type") {
      const ref = typeof body.ref === "string" ? body.ref : "";
      if (!ref) return sendJson(res, { ok: false, status: "error", error: "ref required" }, 400);
      await session.type(ref, typeof body.text === "string" ? body.text : "", body.submit === true);
      return sendJson(res, toResult(await session.snapshot(), `Typed into ${ref}`));
    }
    if (path === "/api/session/wait") {
      await session.wait({
        text: typeof body.text === "string" ? body.text : undefined,
        ref: typeof body.ref === "string" ? body.ref : undefined,
        timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
      });
      return sendJson(res, toResult(await session.snapshot(), "Wait completed"));
    }
    if (path === "/api/session/screenshot") {
      const filePath = join(getScreenshotsDir(userName), `${getTimestamp()}.png`);
      await session.screenshot(filePath, body.fullPage !== false);
      const result = toResult(await session.snapshot(), "Screenshot captured");
      return sendJson(res, { ...result, screenshotPath: toContainerPath(filePath), remoteScreenshotPath: filePath });
    }
    if (path === "/api/session/download") {
      await session.download();
    }
  } catch (error) {
    return sendJson(res, { ok: false, status: "error", error: error instanceof Error ? error.message : String(error) }, 500);
  }

  return sendJson(res, { ok: false, status: "error", error: "unknown endpoint" }, 404);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, { ok: true });
  }
  if (req.method === "POST") {
    return handleApi(req, res, url.pathname);
  }
  return sendJson(res, { ok: false, error: "not found" }, 404);
});

server.listen(PORT, "0.0.0.0", () => {
  const pidPath = readEnv("KELLIX_REMOTE_BROWSER_PIDFILE", "STEVE_REMOTE_BROWSER_PIDFILE");
  if (pidPath) {
    mkdirSync(dirname(pidPath), { recursive: true });
    writeFileSync(pidPath, `${process.pid}\n`, "utf-8");
  }
  console.log(`kellix-remote-browserd listening on ${PORT}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    for (const [userName, session] of sessions) {
      sessions.delete(userName);
      sessionConfigKeys.delete(userName);
      await session.close().catch(() => {});
    }
    server.close(() => process.exit(0));
  });
}
