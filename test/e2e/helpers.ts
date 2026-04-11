import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";

export interface TestEnv {
  project: string;
  webPort: number;
  opencodePortBase: number;
  telegramPort: number;
  telegramToken: string;
  backupPassword: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  backupDir: string;
  localEnvDir: string;
}

export function createTestEnv(cwd: string, name: string): TestEnv {
  const suffix = `${name}-${Date.now()}`;
  const backupDir = join(tmpdir(), `steve-e2e-${suffix}`);
  mkdirSync(backupDir, { recursive: true });
  const localEnvDir = join(backupDir, "local-env");
  mkdirSync(localEnvDir, { recursive: true });
  const basePort = 30000 + Math.floor(Math.random() * 5000);
  const webPort = basePort;
  const telegramPort = basePort + 100;
  const opencodePortBase = basePort + 200;
  const browserViewerPortBase = basePort + 300;
  const browserViewerPortMax = browserViewerPortBase + 19;

  return {
    project: `steve-${suffix}`,
    webPort,
    opencodePortBase,
    telegramPort,
    telegramToken: "test-telegram-token",
    backupPassword: "steve-backup-password",
    cwd,
    backupDir,
    localEnvDir,
    env: {
      ...process.env,
      STEVE_PROJECT: `steve-${suffix}`,
      STEVE_WEB_PORT: String(webPort),
      STEVE_OPENCODE_PORT_BASE: String(opencodePortBase),
      STEVE_BROWSER_VIEWER_PORT_BASE: String(browserViewerPortBase),
      STEVE_BROWSER_VIEWER_PORT_MAX: String(browserViewerPortMax),
      STEVE_TELEGRAM_API_BASE: `http://host.docker.internal:${telegramPort}`,
      STEVE_BACKUP_PASSWORD: "steve-backup-password",
      STEVE_LOCAL_ENV_DIR: localEnvDir,
    },
  };
}

export function cleanupTestEnv(testEnv: TestEnv) {
  rmSync(testEnv.backupDir, { recursive: true, force: true });
}

export function getLocalComposeArgs(cwd: string, project: string, envDir = join(cwd, ".steve-dev")): string[] {
  return [
    "compose",
    "--project-name",
    project,
    "--env-file",
    join(envDir, ".env"),
    "-f",
    join(cwd, "docker-compose.yml"),
    "-f",
    join(envDir, "agents.compose.yml"),
  ];
}

export async function downLocalStack(cwd: string, testEnv: TestEnv) {
  if (!existsSync(join(testEnv.localEnvDir, ".env"))) {
    return;
  }
  await runCommand("docker", [...getLocalComposeArgs(cwd, testEnv.project, testEnv.localEnvDir), "down", "-v"], {
    cwd,
    env: testEnv.env,
    timeoutMs: 120000,
  }).catch(() => {});
}

export function runCommand(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number; capture?: boolean }) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });

    let stdout = "";
    let stderr = "";
    if (options.capture && child.stdout && child.stderr) {
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    }

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Command timed out: ${command} ${args.join(" ")}`));
    }, options.timeoutMs ?? 120000);

    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

export async function waitFor(url: string, timeoutMs = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return res;
    } catch {}
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

export async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function getSetCookies(res: Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

export class CookieJar {
  private cookies = new Map<string, string>();

  absorb(res: Response) {
    for (const cookie of getSetCookies(res)) {
      const [pair] = cookie.split(";", 1);
      const [name, value] = pair.split("=", 2);
      this.cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

export async function requestText(url: string, options: RequestInit & { jar?: CookieJar } = {}) {
  const headers = new Headers(options.headers || {});
  if (options.jar) {
    const cookie = options.jar.header();
    if (cookie) headers.set("cookie", cookie);
  }
  const res = await fetch(url, { ...options, headers, redirect: "manual" });
  options.jar?.absorb(res);
  const text = await res.text();
  return { res, text };
}

export function extractCsrf(html: string): string {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, "Missing CSRF token in HTML response");
  return match[1];
}

export function assertIncludes(text: string, value: string) {
  assert.ok(text.includes(value), `Expected to find ${value}`);
}

type TelegramUpdate = {
  update_id: number;
  message: {
    message_id: number;
    date: number;
    chat: { id: number; type: string };
    from: { id: number; is_bot: boolean; first_name: string };
    text: string;
  };
};

export interface TelegramMockServer {
  origin: string;
  close(): Promise<void>;
  pushTextMessage(chatId: number, text: string): Promise<void>;
  getSentMessages(): Promise<any[]>;
}

export async function startTelegramMockServer(port: number, token: string): Promise<TelegramMockServer> {
  const updates: TelegramUpdate[] = [];
  const sentMessages: any[] = [];
  let nextUpdateId = 1;
  let nextMessageId = 1;

  function sendJson(res: ServerResponse, data: unknown) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  async function readJson(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf-8");
    return body ? JSON.parse(body) : {};
  }

  const server = createServer(async (req, res) => {
    if (!req.url) {
      res.statusCode = 404;
      res.end();
      return;
    }

    if (req.url === "/__test__/push-update" && req.method === "POST") {
      const body = await readJson(req);
      updates.push({
        update_id: nextUpdateId++,
        message: {
          message_id: nextMessageId++,
          date: Math.floor(Date.now() / 1000),
          chat: { id: body.chat_id, type: "private" },
          from: { id: body.chat_id, is_bot: false, first_name: body.first_name || "Test" },
          text: body.text,
        },
      });
      sendJson(res, { ok: true });
      return;
    }

    if (req.url === "/__test__/messages") {
      sendJson(res, sentMessages);
      return;
    }

    if (!req.url.startsWith(`/bot${token}/`)) {
      res.statusCode = 404;
      res.end();
      return;
    }

    const method = req.url.slice(`/bot${token}/`.length).split("?", 1)[0];
    switch (method) {
      case "getMe":
        sendJson(res, { ok: true, result: { id: 1, is_bot: true, first_name: "Steve", username: "steve_test_bot" } });
        return;
      case "setMyCommands":
      case "deleteWebhook":
        sendJson(res, { ok: true, result: true });
        return;
      case "getUpdates": {
        const query = new URL(req.url, `http://127.0.0.1:${port}`).searchParams;
        const offset = Number(query.get("offset") || 0);
        const available = updates.filter((update) => update.update_id >= offset);
        if (available.length > 0) {
          const lastId = available[available.length - 1].update_id;
          for (let i = updates.length - 1; i >= 0; i--) {
            if (updates[i].update_id <= lastId) {
              updates.splice(i, 1);
            }
          }
        }
        sendJson(res, { ok: true, result: available });
        return;
      }
      case "sendMessage":
      case "editMessageText": {
        const body = await readJson(req);
        sentMessages.push({ method, body });
        sendJson(res, { ok: true, result: { message_id: nextMessageId++ } });
        return;
      }
      default:
        sendJson(res, { ok: true, result: true });
    }
  });

  await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve));

  return {
    origin: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    async pushTextMessage(chatId: number, text: string) {
      const res = await fetch(`http://127.0.0.1:${port}/__test__/push-update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      assert.equal(res.status, 200);
    },
    async getSentMessages() {
      const res = await fetch(`http://127.0.0.1:${port}/__test__/messages`);
      return res.json();
    },
  };
}
