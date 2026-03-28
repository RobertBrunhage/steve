import type { Hono } from "hono";
import { existsSync } from "node:fs";
import { readUserActivity } from "../activity.js";
import { config, getBaseUrl, getUserDir, refreshRuntimeConfigFromVault } from "../config.js";
import { deleteUserAppSecret, getUserAppSecret, listUserAppSecrets, setUserAppSecret } from "../secrets.js";
import { generateRuntimeConfig, setupUserWorkspace } from "../setup.js";
import { addOrUpdateTelegramUser, ensureUser, getTelegramChatId, normalizeUsers, writeUserManifest } from "../users.js";
import { mergeFieldsWithExistingValue, parseFields, valueToFields } from "./common.js";
import { getOpenCodePorts, saveOpenCodePorts } from "./common.js";
import {
  getUserAgentLogs,
  restartUserAgent,
  startExistingUserAgent,
  startUserAgent,
  stopUserAgent,
} from "./docker.js";
import { renderUserAgentPage, renderUserIntegrationsPage, renderUserOverview, renderUserSecretEditForm, renderUserSecretNewForm } from "./views.js";
import { validateIntegrationSlug, validateTelegramId, validateUserSlug } from "./validate.js";
import type { WebRouteDeps } from "./types.js";

export function registerUsersRoutes(app: Hono, deps: WebRouteDeps) {
  async function getUserPageState(name: string) {
    const userDir = getUserDir(name);
    if (!existsSync(userDir)) return null;

    let ocStatus = "unknown";
    try {
      const res = await fetch(`http://opencode-${name}:3456`, { signal: AbortSignal.timeout(2000) });
      ocStatus = res.ok ? "running" : "stopped";
    } catch {
      ocStatus = "stopped";
    }

    const ports = getOpenCodePorts();
    const ocPort = ports[name] || 0;
    const baseUrl = new URL(getBaseUrl());
    const ocUrl = ocPort ? `http://${baseUrl.hostname}:${ocPort}` : "";
    const users = normalizeUsers(deps.getVault()?.get("steve/users")).users;

    return {
      ocStatus,
      ocUrl,
      telegramChatId: getTelegramChatId(users, name),
      userSecrets: listUserAppSecrets(deps.getVault(), name),
      recentActivity: readUserActivity(config.dataDir, name, 6),
    };
  }

  app.post("/users/add", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const vault = deps.getVault();
    if (!vault) return c.redirect("/");

    const name = String(result.body.name || "").trim();
    const validatedName = validateUserSlug(name);
    if (!validatedName.ok) {
      return c.redirect("/");
    }

    const existing = normalizeUsers(vault.get("steve/users")).users;
    const updatedUsers = ensureUser(existing, validatedName.value);
    vault.set("steve/users", updatedUsers as any);
    refreshRuntimeConfigFromVault(vault);
    setupUserWorkspace(validatedName.value);
    generateRuntimeConfig(updatedUsers);
    writeUserManifest(config.dataDir, updatedUsers);
    return c.redirect(`/users/${validatedName.value}`);
  });

  app.post("/users/:name/telegram", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const vault = deps.getVault();
    if (!vault) return c.redirect("/");

    const validatedName = validateUserSlug(c.req.param("name"));
    const telegramId = String(result.body.telegram_id || "").trim();
    if (!validatedName.ok || !validateTelegramId(telegramId)) {
      return c.redirect(`/users/${c.req.param("name")}`);
    }

    const existing = normalizeUsers(vault.get("steve/users")).users;
    const updatedUsers = addOrUpdateTelegramUser(existing, validatedName.value, telegramId);
    vault.set("steve/users", updatedUsers as any);
    refreshRuntimeConfigFromVault(vault);
    writeUserManifest(config.dataDir, updatedUsers);
    return c.redirect(`/users/${validatedName.value}`);
  });

  app.get("/users/:name/integrations/new", (c) => {
    const session = deps.requireAdminPage(c);
    if (session instanceof Response) return session;

    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    const validatedInitialIntegration = validateIntegrationSlug(String(c.req.query("integration") || ""));
    const initialIntegration = validatedInitialIntegration.ok ? validatedInitialIntegration.value : "";
    return c.html(renderUserSecretNewForm(validatedName.value, undefined, session.csrfToken, initialIntegration));
  });

  app.post("/users/:name/integrations", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const vault = deps.getVault();
    if (!vault) return c.redirect("/");

    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");

    const validatedIntegration = validateIntegrationSlug(String(result.body.integration || ""));
    if (!validatedIntegration.ok) {
      return c.html(renderUserSecretNewForm(validatedName.value, validatedIntegration.error, result.session.csrfToken, String(result.body.integration || "")), 400);
    }

    const fields = parseFields(result.body);
    if (Object.keys(fields).length === 0) {
      return c.html(renderUserSecretNewForm(validatedName.value, "At least one field is required", result.session.csrfToken, validatedIntegration.value), 400);
    }

    setUserAppSecret(vault, validatedName.value, validatedIntegration.value, fields);
    return c.redirect(`/users/${validatedName.value}/integrations`);
  });

  app.get("/users/:name/integrations/:integration/edit", (c) => {
    const session = deps.requireAdminPage(c);
    if (session instanceof Response) return session;

    const validatedName = validateUserSlug(c.req.param("name"));
    const validatedIntegration = validateIntegrationSlug(c.req.param("integration"));
    if (!validatedName.ok || !validatedIntegration.ok) return c.redirect("/");

    const vault = deps.getVault();
    const current = getUserAppSecret(vault, validatedName.value, validatedIntegration.value);
    if (!current) return c.redirect(`/users/${validatedName.value}/integrations`);

    return c.html(renderUserSecretEditForm(
      validatedName.value,
      validatedIntegration.value,
      valueToFields(current.key, typeof current.value === "object" ? current.value as Record<string, unknown> : current.value),
      undefined,
      session.csrfToken,
    ));
  });

  app.post("/users/:name/integrations/:integration", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const vault = deps.getVault();
    if (!vault) return c.redirect("/");

    const validatedName = validateUserSlug(c.req.param("name"));
    const validatedIntegration = validateIntegrationSlug(c.req.param("integration"));
    if (!validatedName.ok || !validatedIntegration.ok) return c.redirect("/");

    const current = getUserAppSecret(vault, validatedName.value, validatedIntegration.value);
    if (!current) return c.redirect(`/users/${validatedName.value}/integrations`);

    const fields = parseFields(result.body);
    if (Object.keys(fields).length === 0) {
      return c.html(renderUserSecretEditForm(
        validatedName.value,
        validatedIntegration.value,
        valueToFields(current.key, typeof current.value === "object" ? current.value as Record<string, unknown> : current.value),
        "At least one field is required",
        result.session.csrfToken,
      ), 400);
    }

    const existingValue = typeof current.value === "object" ? current.value as Record<string, unknown> : current.value;
    const nextValue = mergeFieldsWithExistingValue(existingValue, fields);
    setUserAppSecret(vault, validatedName.value, validatedIntegration.value, nextValue as Record<string, string>);
    return c.redirect(`/users/${validatedName.value}/integrations`);
  });

  app.post("/users/:name/integrations/:integration/delete", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const vault = deps.getVault();
    if (!vault) return c.redirect("/");

    const validatedName = validateUserSlug(c.req.param("name"));
    const validatedIntegration = validateIntegrationSlug(c.req.param("integration"));
    if (!validatedName.ok || !validatedIntegration.ok) return c.redirect("/");

    deleteUserAppSecret(vault, validatedName.value, validatedIntegration.value);
    return c.redirect(`/users/${validatedName.value}/integrations`);
  });

  app.post("/users/:name/start", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    const name = validatedName.value;

    try {
      if (!startExistingUserAgent(deps.composeProject, name)) {
        const ports = getOpenCodePorts();
        const nextPort = Math.max(config.opencodePortBase, ...Object.values(ports)) + 1;
        const portNumber = ports[name] || nextPort;
        ports[name] = portNumber;
        saveOpenCodePorts(ports);

        startUserAgent({
          composeProject: deps.composeProject,
          dataDir: config.dataDir,
          image: process.env.STEVE_OPENCODE_IMAGE || "ghcr.io/robertbrunhage/steve-opencode:latest",
          name,
          port: portNumber,
        });
      }
    } catch (err) {
      console.error("Failed to start agent:", err instanceof Error ? err.message : err);
    }

    return c.redirect(`/users/${name}`);
  });

  app.post("/users/:name/stop", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    try {
      stopUserAgent(deps.composeProject, validatedName.value);
    } catch {}
    return c.redirect(`/users/${validatedName.value}`);
  });

  app.post("/users/:name/restart", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    try {
      restartUserAgent(deps.composeProject, validatedName.value);
    } catch {}
    return c.redirect(`/users/${validatedName.value}`);
  });

  app.get("/users/:name", async (c) => {
    const session = deps.requireAdminPage(c);
    if (session instanceof Response) return session;

    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    const name = validatedName.value;
    const state = await getUserPageState(name);
    if (!state) return c.redirect("/");
    return c.html(renderUserOverview(name, state.ocStatus, session.csrfToken, state));
  });

  app.get("/users/:name/integrations", async (c) => {
    const session = deps.requireAdminPage(c);
    if (session instanceof Response) return session;

    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    const state = await getUserPageState(validatedName.value);
    if (!state) return c.redirect("/");
    return c.html(renderUserIntegrationsPage(validatedName.value, state.ocStatus, session.csrfToken, state));
  });

  app.get("/users/:name/agent", async (c) => {
    const session = deps.requireAdminPage(c);
    if (session instanceof Response) return session;

    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    const state = await getUserPageState(validatedName.value);
    if (!state) return c.redirect("/");
    return c.html(renderUserAgentPage(validatedName.value, state.ocStatus, state.ocUrl, session.csrfToken));
  });

  app.get("/users/:name/logs", (c) => {
    const session = deps.requireAdminApi(c);
    if (session instanceof Response) return session;

    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.json({ logs: "Invalid user" }, 400);
    try {
      return c.json({ logs: getUserAgentLogs(deps.composeProject, validatedName.value) || "No logs" });
    } catch (err) {
      return c.json({ logs: err instanceof Error ? err.message : "Could not fetch logs" });
    }
  });

  app.get("/users/:name/sessions", async (c) => {
    const session = deps.requireAdminApi(c);
    if (session instanceof Response) return session;

    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.json({ error: "Invalid user" }, 400);
    try {
      const res = await fetch(`http://opencode-${validatedName.value}:3456/session`, {
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
}
