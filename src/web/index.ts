import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Vault } from "../vault/index.js";
import { renderDashboard, renderNewForm, renderEditForm, renderSetup } from "./views.js";

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
  app.get("/oauth/code", (c) => {
    if (pendingOAuthCode && Date.now() - pendingOAuthCode.ts < 300_000) {
      const { code, state } = pendingOAuthCode;
      pendingOAuthCode = null;
      return c.json({ code, state });
    }
    return c.json({ code: null }, 404);
  });

  // Setup page (first run)
  app.get("/setup", (c) => {
    return c.html(renderSetup());
  });

  app.post("/setup", async (c) => {
    const body = await c.req.parseBody();
    const botToken = String(body.bot_token || "").trim();
    const usersRaw = String(body.users || "").trim();
    const model = String(body.model || "openai/gpt-5.2").trim();

    if (!botToken) return c.html(renderSetup("Bot token is required"), 400);
    if (!usersRaw) return c.html(renderSetup("At least one user is required"), 400);

    const users: Record<string, string> = {};
    for (const line of usersRaw.split("\n")) {
      const [id, name] = line.trim().split(":");
      if (id && name) users[id.trim()] = name.trim();
    }

    if (Object.keys(users).length === 0) {
      return c.html(renderSetup("Invalid user format. Use id:Name, one per line."), 400);
    }

    vault.set("telegram/bot_token", botToken as any);
    vault.set("telegram/users", users as any);
    vault.set("steve/model", model as any);

    return c.html(renderDashboard(vault.list(), getFieldNames(vault), "Setup complete! Steve is starting..."));
  });

  // Redirect /secrets to add form (this is the URL the AI tells users to visit)
  app.get("/secrets", (c) => c.redirect("/secrets/new"));

  // Dashboard
  app.get("/", (c) => {
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

  serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });

  return app;
}
