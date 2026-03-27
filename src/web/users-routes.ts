import type { Hono } from "hono";
import { existsSync } from "node:fs";
import { config, getBaseUrl, getUserDir } from "../config.js";
import { writeUserManifest } from "../users.js";
import { getOpenCodePorts, saveOpenCodePorts } from "./common.js";
import {
  getUserAgentLogs,
  restartUserAgent,
  startExistingUserAgent,
  startUserAgent,
  stopUserAgent,
} from "./docker.js";
import { renderUserDetail } from "./views.js";
import { validateTelegramId, validateUserSlug } from "./validate.js";
import type { WebRouteDeps } from "./types.js";

export function registerUsersRoutes(app: Hono, deps: WebRouteDeps) {
  app.post("/users/add", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const vault = deps.getVault();
    if (!vault) return c.redirect("/");

    const name = String(result.body.name || "").trim();
    const telegramId = String(result.body.telegram_id || "").trim();
    const validatedName = validateUserSlug(name);
    if (!validatedName.ok || !validateTelegramId(telegramId)) {
      return c.redirect("/");
    }

    const existing = (vault.get("steve/users") as Record<string, string>) || {};
    existing[telegramId] = validatedName.value;
    vault.set("steve/users", existing as any);
    writeUserManifest(config.dataDir, existing);
    return c.redirect("/");
  });

  app.post("/users/:name/start", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    const name = validatedName.value;

    try {
      if (!startExistingUserAgent(name)) {
        const ports = getOpenCodePorts();
        const nextPort = Math.max(3456, ...Object.values(ports)) + 1;
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
      stopUserAgent(validatedName.value);
    } catch {}
    return c.redirect(`/users/${validatedName.value}`);
  });

  app.post("/users/:name/restart", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    try {
      restartUserAgent(validatedName.value);
    } catch {}
    return c.redirect(`/users/${validatedName.value}`);
  });

  app.get("/users/:name", async (c) => {
    const session = deps.requireAdminPage(c);
    if (session instanceof Response) return session;

    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    const name = validatedName.value;
    const userDir = getUserDir(name);
    if (!existsSync(userDir)) return c.redirect("/");

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

    return c.html(renderUserDetail(name, ocStatus, ocUrl, session.csrfToken));
  });

  app.get("/users/:name/logs", (c) => {
    const session = deps.requireAdminApi(c);
    if (session instanceof Response) return session;

    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.json({ logs: "Invalid user" }, 400);
    try {
      return c.json({ logs: getUserAgentLogs(validatedName.value) || "No logs" });
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
