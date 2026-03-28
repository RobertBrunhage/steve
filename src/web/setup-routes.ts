import type { Hono } from "hono";
import { config } from "../config.js";
import { Vault, initializeVault } from "../vault/index.js";
import { getHealth } from "../health.js";
import { ensureUser, normalizeUsers, type UsersMap } from "../users.js";
import { ADMIN_AUTH_KEY, hashPassword, verifyPassword } from "./auth.js";
import { renderLogin, renderSetupComplete, renderSetupLocked } from "./views.js";
import { validateUserSlug } from "./validate.js";
import type { WebRouteDeps } from "./types.js";

export function registerSetupRoutes(app: Hono, deps: WebRouteDeps) {
  let pendingOAuthCode: { code: string; state: string; ts: number } | null = null;

  function needsDashboardPasswordOnly(): boolean {
    const vault = deps.getVault();
    if (!vault) return false;
    const hasBotToken = !!vault.getString("telegram/bot_token");
    const hasUsers = Object.keys(normalizeUsers(vault.get("steve/users")).users).length > 0;
    return hasBotToken && hasUsers;
  }

  app.get("/callback", (c) => {
    const code = c.req.query("code") || "";
    const state = c.req.query("state") || "";
    if (code && state) {
      pendingOAuthCode = { code, state, ts: Date.now() };
    }
    return c.html(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;background:#111;color:#fff">
      <h2>${code ? "Done! Return to Telegram." : "No code received."}</h2>
      <p>You can close this tab.</p></body></html>`);
  });

  app.get("/oauth/code", (c) => {
    const requestedState = c.req.query("state") || "";
    if (pendingOAuthCode && requestedState && requestedState === pendingOAuthCode.state && Date.now() - pendingOAuthCode.ts < 300_000) {
      const { code, state } = pendingOAuthCode;
      return c.json({ code, state });
    }
    return c.json({ code: null }, 404);
  });

  app.delete("/oauth/code", (c) => {
    const requestedState = c.req.query("state") || "";
    if (pendingOAuthCode && requestedState && requestedState === pendingOAuthCode.state) {
      pendingOAuthCode = null;
    }
    return c.json({ ok: true });
  });

  app.get("/setup", (c) => {
    if (deps.isAdminConfigured()) {
      return deps.getAdminSession(c) ? c.redirect("/") : c.redirect("/login");
    }

    const token = c.req.query("token") || "";
    const expected = deps.ensureSetupToken();
    if (!expected || token !== expected) {
      return c.html(renderSetupLocked(), 403);
    }

    const session = deps.issueBootstrapSession(c);
    return c.html(deps.buildSetupView(session.csrfToken, undefined, needsDashboardPasswordOnly()));
  });

  app.post("/setup", async (c) => {
    if (deps.isAdminConfigured()) {
      return c.redirect("/login");
    }

    const session = deps.getBootstrapSession(c);
    if (!session) {
      return c.html(renderSetupLocked(), 403);
    }

    const body = await c.req.parseBody();
    if (String(body._csrf || "") !== session.csrfToken) {
      return c.text("Invalid CSRF token", 403);
    }

    const authOnly = needsDashboardPasswordOnly();
    const password = String(body.password || "").trim();
    const confirmPassword = String(body.confirm_password || "").trim();
    if (!password) return c.html(deps.buildSetupView(session.csrfToken, "Password is required", authOnly), 400);
    if (password.length < 8) return c.html(deps.buildSetupView(session.csrfToken, "Password must be at least 8 characters", authOnly), 400);
    if (password !== confirmPassword) return c.html(deps.buildSetupView(session.csrfToken, "Passwords do not match", authOnly), 400);

    let botToken = "";
    let users: UsersMap = {};

    if (authOnly) {
      const vault = deps.getVault();
      if (!vault) {
        return c.html(deps.buildSetupView(session.csrfToken, "Vault not available for restored setup", authOnly), 500);
      }
      botToken = vault.getString("telegram/bot_token") || "";
      users = normalizeUsers(vault.get("steve/users")).users;
    } else {
      botToken = String(body.bot_token || "").trim();
      if (!botToken) return c.html(deps.buildSetupView(session.csrfToken, "Bot token is required", authOnly), 400);

      try {
        const res = await deps.telegramFetch(`https://api.telegram.org/bot${botToken}/getMe`);
        const data = await res.json() as { ok: boolean; description?: string };
        if (!data.ok) {
          return c.html(deps.buildSetupView(session.csrfToken, `Invalid bot token: ${data.description || "check your token"}`, authOnly), 400);
        }
      } catch {
        return c.html(deps.buildSetupView(session.csrfToken, "Could not validate bot token. Check your internet connection.", authOnly), 400);
      }

      for (let i = 0; i < 20; i++) {
        const rawName = String(body[`user_name_${i}`] || "").trim();
        if (!rawName) continue;

        const validatedName = validateUserSlug(rawName);
        if (!validatedName.ok) {
          return c.html(deps.buildSetupView(session.csrfToken, validatedName.error, authOnly), 400);
        }

        users = ensureUser(users, validatedName.value);
      }

      if (Object.keys(users).length === 0) {
        return c.html(deps.buildSetupView(session.csrfToken, "Add at least one user", authOnly), 400);
      }
    }

    let vault = deps.getVault();
    if (!vault) {
      try {
        const keyfile = initializeVault(config.vaultDir, password);
        vault = new Vault(config.vaultDir, keyfile);
        deps.setVault(vault);
      } catch (err) {
        return c.html(deps.buildSetupView(session.csrfToken, `Failed to create vault: ${err instanceof Error ? err.message : err}`), 500);
      }
    }

    vault.set(ADMIN_AUTH_KEY, hashPassword(password) as any);
    vault.set("telegram/bot_token", botToken as any);
    vault.set("steve/users", users as any);

    deps.clearBootstrapSession(c);
    deps.clearSetupToken();
    deps.issueAdminSession(c);

    const firstUser = Object.keys(users)[0];
    return c.html(renderSetupComplete(
      authOnly ? "/" : firstUser ? `/users/${encodeURIComponent(firstUser)}` : "/",
      authOnly ? "Go to Dashboard" : firstUser ? "Connect Telegram" : "Go to Dashboard",
    ));
  });

  app.get("/login", (c) => {
    if (!deps.isAdminConfigured()) {
      return c.redirect("/setup");
    }
    if (deps.getAdminSession(c)) {
      return c.redirect("/");
    }
    return c.html(renderLogin());
  });

  app.post("/login", async (c) => {
    if (!deps.isAdminConfigured()) {
      return c.redirect("/setup");
    }

    const body = await c.req.parseBody();
    const password = String(body.password || "").trim();
    if (!verifyPassword(password, deps.getAdminAuthRecord())) {
      return c.html(renderLogin("Invalid password"), 401);
    }

    deps.issueAdminSession(c);
    return c.redirect("/");
  });

  app.post("/logout", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;
    deps.clearAdminSession(c);
    return c.redirect("/login");
  });

  app.get("/healthz", async (c) => {
    const health = await getHealth();
    return c.json(health, health.healthy ? 200 : 503);
  });
}
