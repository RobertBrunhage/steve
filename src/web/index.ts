import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Vault, initializeVault } from "../vault/index.js";
import { getHealth } from "../health.js";
import { config, getUserDir } from "../config.js";

function getOpenCodePorts(): Record<string, number> {
  const portsPath = join(config.dataDir, "opencode-ports.json");
  try {
    if (existsSync(portsPath)) {
      return JSON.parse(readFileSync(portsPath, "utf-8"));
    }
  } catch {}
  return {};
}
import { renderDashboard, renderNewForm, renderEditForm, renderSetup, renderSetupComplete, renderHome, renderUserDetail } from "./views.js";

/** Parse field_name_0, field_value_0, field_name_1, field_value_1... into a JSON object */
function parseFields(body: Record<string, string | File>): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < 100; i++) {
    const name = String(body[`field_name_${i}`] || "").trim();
    const value = String(body[`field_value_${i}`] || "").trim();
    if (!name) continue;
    result[name] = value;
  }
  return result;
}

/** Get field names for each vault key (for dashboard display) */
function getFieldNames(v: Vault): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const key of v.list()) {
    const val = v.get(key);
    if (val && typeof val === "object") {
      result[key] = Object.keys(val);
    }
  }
  return result;
}

/** Convert vault value to field pairs for edit form */
function valueToFields(val: Record<string, unknown> | null): [string, string][] {
  if (!val || typeof val !== "object") return [["", ""]];
  return Object.entries(val).map(([k, v]) => [k, String(v)]);
}

/** Detect the compose project name from our own container's labels */
function getComposeProject(): string {
  try {
    const label = execSync(
      "docker inspect steve --format '{{index .Config.Labels \"com.docker.compose.project\"}}'",
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
    if (label) return label;
  } catch {}
  return "steve";
}

export function startWebServer(vault: Vault | null, port: number) {
  let currentVault = vault;
  const composeProject = getComposeProject();
  const app = new Hono();

  // OAuth callback — captures authorization codes from external providers
  let pendingOAuthCode: { code: string; state: string; ts: number } | null = null;

  app.get("/callback", (c) => {
    const code = c.req.query("code") || "";
    const state = c.req.query("state") || "";
    if (code) {
      pendingOAuthCode = { code, state, ts: Date.now() };
    }
    return c.html(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;background:#111;color:#fff">
      <h2>${code ? "Done! Return to Telegram." : "No code received."}</h2>
      <p>You can close this tab.</p></body></html>`);
  });

  // Internal endpoint for scripts to poll for the captured code
  // Code persists until explicitly consumed via DELETE or expires after 5 min
  app.get("/oauth/code", (c) => {
    if (pendingOAuthCode && Date.now() - pendingOAuthCode.ts < 300_000) {
      const { code, state } = pendingOAuthCode;
      return c.json({ code, state });
    }
    return c.json({ code: null }, 404);
  });

  // Consume the code after successful token exchange
  app.delete("/oauth/code", (c) => {
    pendingOAuthCode = null;
    return c.json({ ok: true });
  });

  // Setup page (first run)
  app.get("/setup", (c) => {
    return c.html(renderSetup(!currentVault));
  });

  app.post("/setup", async (c) => {
    const body = await c.req.parseBody();

    // Initialize vault from password if needed
    if (!currentVault) {
      const password = String(body.password || "").trim();
      const confirmPassword = String(body.confirm_password || "").trim();
      if (!password) return c.html(renderSetup(true, "Password is required"), 400);
      if (password.length < 8) return c.html(renderSetup(true, "Password must be at least 8 characters"), 400);
      if (password !== confirmPassword) return c.html(renderSetup(true, "Passwords do not match"), 400);

      try {
        const keyfile = initializeVault(config.vaultDir, password);
        currentVault = new Vault(config.vaultDir, keyfile);
      } catch (err) {
        return c.html(renderSetup(true, `Failed to create vault: ${err instanceof Error ? err.message : err}`), 500);
      }
    }

    const botToken = String(body.bot_token || "").trim();
    if (!botToken) return c.html(renderSetup(false, "Bot token is required"), 400);

    // Validate bot token
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
      const data = await res.json() as { ok: boolean; description?: string };
      if (!data.ok) {
        return c.html(renderSetup(false, `Invalid bot token: ${data.description || "check your token"}`), 400);
      }
    } catch {
      return c.html(renderSetup(false, "Could not validate bot token. Check your internet connection."), 400);
    }

    // Parse users from dynamic fields
    const users: Record<string, string> = {};
    for (let i = 0; i < 20; i++) {
      const id = String(body[`user_id_${i}`] || "").trim();
      const name = String(body[`user_name_${i}`] || "").trim();
      if (id && name && !isNaN(Number(id))) {
        users[id] = name;
      }
    }

    if (Object.keys(users).length === 0) {
      return c.html(renderSetup(false, "Add at least one user"), 400);
    }

    currentVault.set("telegram/bot_token", botToken as any);
    currentVault.set("steve/users", users as any);

    return c.html(renderSetupComplete());
  });

  // Add user
  app.post("/users/add", async (c) => {
    const body = await c.req.parseBody();
    const name = String(body.name || "").trim();
    const telegramId = String(body.telegram_id || "").trim();

    if (!name || !telegramId || isNaN(Number(telegramId))) {
      return c.redirect("/");
    }

    // Add to vault
    const existing = (currentVault!.get("steve/users") as Record<string, string>) || {};
    existing[telegramId] = name;
    currentVault!.set("steve/users", existing as any);

    // Write updated users.json — launch.ts watches this and starts new containers
    const allUsers = [...new Set(Object.values(existing).map((n) => n.toLowerCase()))];
    writeFileSync(join(config.dataDir, "users.json"), JSON.stringify({ users: allUsers }, null, 2), "utf-8");

    return c.redirect("/");
  });

  // Health API (JSON)
  app.get("/healthz", async (c) => {
    const health = await getHealth();
    return c.json(health, health.healthy ? 200 : 503);
  });

  // Home — redirect to setup if not configured, otherwise dashboard
  app.get("/", async (c) => {
    if (!currentVault || !currentVault.has("telegram/bot_token") || !currentVault.has("steve/users")) {
      return c.redirect("/setup");
    }
    const health = await getHealth();
    const keys = currentVault!.list();
    return c.html(renderHome(health, keys, getFieldNames(currentVault!)));
  });

  // Redirect /secrets to add form (this is the URL the AI tells users to visit)
  app.get("/secrets", (c) => c.redirect("/secrets/new"));

  // Secrets list
  app.get("/secrets/list", (c) => {
    const keys = currentVault!.list();
    return c.html(renderDashboard(keys, getFieldNames(currentVault!)));
  });

  // New secret form
  app.get("/secrets/new", (c) => {
    return c.html(renderNewForm());
  });

  // Create secret
  app.post("/secrets", async (c) => {
    const body = await c.req.parseBody();
    const key = String(body.key || "").trim();

    if (!key) return c.html(renderNewForm("Name is required"), 400);

    const fields = parseFields(body);
    if (Object.keys(fields).length === 0) {
      return c.html(renderNewForm("At least one field is required"), 400);
    }

    currentVault!.set(key, fields);
    return c.redirect("/");
  });

  // Edit secret form
  app.get("/secrets/:key/edit", (c) => {
    const key = decodeURIComponent(c.req.param("key"));
    const current = currentVault!.get(key);
    if (!current) return c.redirect("/");
    return c.html(renderEditForm(key, valueToFields(current)));
  });

  // Update secret
  app.post("/secrets/:key", async (c) => {
    const key = decodeURIComponent(c.req.param("key"));
    const body = await c.req.parseBody();

    const fields = parseFields(body);
    if (Object.keys(fields).length === 0) {
      const current = currentVault!.get(key);
      return c.html(renderEditForm(key, valueToFields(current), "At least one field is required"), 400);
    }

    currentVault!.set(key, fields);
    return c.redirect("/");
  });

  // Delete secret
  app.post("/secrets/:key/delete", (c) => {
    const key = decodeURIComponent(c.req.param("key"));
    currentVault!.delete(key);
    return c.redirect("/");
  });

  // Start user agent
  app.post("/users/:name/start", (c) => {
    const name = c.req.param("name").toLowerCase();
    try {
      // Try starting existing container first
      try {
        execSync(`docker start opencode-${name}`, { stdio: "ignore", timeout: 10000 });
      } catch {
        // Container doesn't exist — create via a temp compose file
        const ports = getOpenCodePorts();
        const nextPort = Math.max(3456, ...Object.values(ports)) + 1;
        const port = ports[name] || nextPort;
        ports[name] = port;
        writeFileSync(join(config.dataDir, "opencode-ports.json"), JSON.stringify(ports, null, 2), "utf-8");

        // Ensure user workspace exists
        for (const sub of ["memory", "memory/daily", "memory/nutrition", "memory/training", "memory/body-measurements"]) {
          mkdirSync(join(config.dataDir, "users", name, sub), { recursive: true });
        }
        mkdirSync(join(config.dataDir, "users", name, ".opencode-data"), { recursive: true });

        const composeContent = [
          "services:",
          `  opencode-${name}:`,
          `    image: ${process.env.STEVE_OPENCODE_IMAGE || "ghcr.io/robertbrunhage/steve-opencode:latest"}`,
          `    container_name: opencode-${name}`,
          "    restart: unless-stopped",
          '    command: ["serve", "--port", "3456", "--hostname", "0.0.0.0"]',
          "    working_dir: /data",
          "    ports:",
          `      - "${port}:3456"`,
          "    volumes:",
          "      - type: volume",
          `        source: ${composeProject}_steve-data`,
          "        target: /data",
          "        volume:",
          `          subpath: users/${name}`,
          "      - type: volume",
          `        source: ${composeProject}_steve-data`,
          "        target: /data/skills",
          "        volume:",
          "          subpath: skills",
          "      - type: volume",
          `        source: ${composeProject}_steve-data`,
          "        target: /data/shared",
          "        volume:",
          "          subpath: shared",
          "      - type: volume",
          `        source: ${composeProject}_steve-data`,
          "        target: /root/.local/share/opencode",
          "        volume:",
          `          subpath: users/${name}/.opencode-data`,
          `    networks: [${composeProject}_steve-net]`,
          "",
          "volumes:",
          `  ${composeProject}_steve-data:`,
          "    external: true",
          "",
          "networks:",
          `  ${composeProject}_steve-net:`,
          "    external: true",
        ].join("\n");

        const composeFile = `/tmp/opencode-${name}.yml`;
        writeFileSync(composeFile, composeContent, "utf-8");
        execSync(`docker compose -p ${composeProject} -f ${composeFile} up -d`, { stdio: "ignore", timeout: 30000 });
      }
    } catch (err) {
      console.error("Failed to start agent:", err instanceof Error ? err.message : err);
    }
    return c.redirect(`/users/${name}`);
  });

  // Stop user agent
  app.post("/users/:name/stop", (c) => {
    const name = c.req.param("name").toLowerCase();
    try {
      execSync(`docker stop opencode-${name}`, { stdio: "ignore", timeout: 15000 });
    } catch {}
    return c.redirect(`/users/${name}`);
  });

  // Restart user agent
  app.post("/users/:name/restart", (c) => {
    const name = c.req.param("name").toLowerCase();
    try {
      execSync(`docker restart opencode-${name}`, { stdio: "ignore", timeout: 15000 });
    } catch {}
    return c.redirect(`/users/${name}`);
  });

  // User detail page
  app.get("/users/:name", async (c) => {
    const name = c.req.param("name").toLowerCase();
    const userDir = getUserDir(name);
    if (!existsSync(userDir)) return c.redirect("/");

    // Check OpenCode status
    let ocStatus = "unknown";
    try {
      const res = await fetch(`http://opencode-${name}:3456`, { signal: AbortSignal.timeout(2000) });
      ocStatus = res.ok ? "running" : "stopped";
    } catch {
      ocStatus = "stopped";
    }

    const ports = getOpenCodePorts();
    const hostIp = process.env.STEVE_HOST_IP || "localhost";
    const ocPort = ports[name] || 0;
    const ocUrl = ocPort ? `http://${hostIp}:${ocPort}` : "";

    return c.html(renderUserDetail(name, ocStatus, ocUrl));
  });

  // User container logs (JSON API)
  app.get("/users/:name/logs", (c) => {
    const name = c.req.param("name").toLowerCase();
    try {
      const logs = execSync(`docker logs opencode-${name} --tail 100 2>&1`, {
        encoding: "utf-8",
        timeout: 5000,
      });
      return c.json({ logs });
    } catch (err) {
      return c.json({ logs: err instanceof Error ? err.message : "Could not fetch logs" });
    }
  });

  // User OpenCode sessions (JSON API)
  app.get("/users/:name/sessions", async (c) => {
    const name = c.req.param("name").toLowerCase();
    try {
      const res = await fetch(`http://opencode-${name}:3456/session`, {
        headers: { "x-opencode-directory": "/data" },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = await res.json();
        return c.json(data);
      }
      return c.json({ error: `HTTP ${res.status}` }, 502);
    } catch {
      return c.json({ error: "OpenCode not reachable" }, 502);
    }
  });

  serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });

  return app;
}
