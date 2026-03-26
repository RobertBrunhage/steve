import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Vault } from "../vault/index.js";
import { getHealth } from "../health.js";
import { config, getUserDir, DEFAULT_MODEL } from "../config.js";

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
function getFieldNames(vault: Vault): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const key of vault.list()) {
    const val = vault.get(key);
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

export function startWebServer(vault: Vault, port: number) {
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
    return c.html(renderSetup());
  });

  app.post("/setup", async (c) => {
    const body = await c.req.parseBody();
    const botToken = String(body.bot_token || "").trim();
    const model = String(body.model || "openai/gpt-5.2").trim();

    if (!botToken) return c.html(renderSetup("Bot token is required"), 400);

    // Validate bot token
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
      const data = await res.json() as { ok: boolean; description?: string };
      if (!data.ok) {
        return c.html(renderSetup(`Invalid bot token: ${data.description || "check your token"}`), 400);
      }
    } catch {
      return c.html(renderSetup("Could not validate bot token. Check your internet connection."), 400);
    }

    // Parse users from dynamic fields — check both naming conventions
    const users: Record<string, string> = {};
    const allKeys = Object.keys(body);
    for (let i = 0; i < 20; i++) {
      const id = String(body[`user_id_${i}`] || "").trim();
      const name = String(body[`user_name_${i}`] || "").trim();
      if (id && name && !isNaN(Number(id))) {
        users[id] = name;
      }
    }

    // Also try legacy format (id:Name per line in a textarea)
    const usersRaw = String(body.users || "").trim();
    if (usersRaw) {
      for (const line of usersRaw.split("\n")) {
        const parts = line.trim().split(":");
        if (parts.length >= 2) {
          const id = parts[0].trim();
          const name = parts.slice(1).join(":").trim();
          if (id && name && !isNaN(Number(id))) {
            users[id] = name;
          }
        }
      }
    }

    if (Object.keys(users).length === 0) {
      return c.html(renderSetup(`Add at least one user (received fields: ${allKeys.filter(k => k.startsWith("user")).join(", ") || "none"})`), 400);
    }

    vault.set("telegram/bot_token", botToken as any);
    vault.set("telegram/users", users as any);

    return c.html(renderSetupComplete());
  });

  // Health API (JSON)
  app.get("/healthz", async (c) => {
    const health = await getHealth();
    return c.json(health, health.healthy ? 200 : 503);
  });

  // Home — redirect to setup if not configured, otherwise dashboard
  app.get("/", async (c) => {
    if (!vault.has("telegram/bot_token") || !vault.has("telegram/users")) {
      return c.redirect("/setup");
    }
    const health = await getHealth();
    const keys = vault.list();
    return c.html(renderHome(health, keys, getFieldNames(vault)));
  });

  // Redirect /secrets to add form (this is the URL the AI tells users to visit)
  app.get("/secrets", (c) => c.redirect("/secrets/new"));

  // Secrets list
  app.get("/secrets/list", (c) => {
    const keys = vault.list();
    return c.html(renderDashboard(keys, getFieldNames(vault)));
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

    vault.set(key, fields);
    return c.redirect("/");
  });

  // Edit secret form
  app.get("/secrets/:key/edit", (c) => {
    const key = decodeURIComponent(c.req.param("key"));
    const current = vault.get(key);
    if (!current) return c.redirect("/");
    return c.html(renderEditForm(key, valueToFields(current)));
  });

  // Update secret
  app.post("/secrets/:key", async (c) => {
    const key = decodeURIComponent(c.req.param("key"));
    const body = await c.req.parseBody();

    const fields = parseFields(body);
    if (Object.keys(fields).length === 0) {
      const current = vault.get(key);
      return c.html(renderEditForm(key, valueToFields(current), "At least one field is required"), 400);
    }

    vault.set(key, fields);
    return c.redirect("/");
  });

  // Delete secret
  app.post("/secrets/:key/delete", (c) => {
    const key = decodeURIComponent(c.req.param("key"));
    vault.delete(key);
    return c.redirect("/");
  });

  // User detail page
  app.get("/users/:name", async (c) => {
    const name = c.req.param("name").toLowerCase();
    const userDir = getUserDir(name);
    if (!existsSync(userDir)) return c.redirect("/");

    // Read settings
    let settings = { model: DEFAULT_MODEL };
    const settingsPath = join(userDir, "settings.json");
    try {
      if (existsSync(settingsPath)) {
        settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      }
    } catch {}

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

    return c.html(renderUserDetail(name, settings, ocStatus, ocUrl));
  });

  // User settings save
  app.post("/users/:name/settings", async (c) => {
    const name = c.req.param("name").toLowerCase();
    const body = await c.req.parseBody();
    const model = String(body.model || DEFAULT_MODEL).trim();

    const settingsPath = join(getUserDir(name), "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ model }, null, 2), "utf-8");

    return c.redirect(`/users/${name}`);
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
