import type { Hono } from "hono";
import { getHealth } from "../health.js";
import { getSteveVersion, getSystemTimezone, getTelegramApiBase, isValidTimezone, refreshRuntimeConfigFromVault, writeSystemSettings } from "../config.js";
import { getTelegramBotToken, setTelegramBotToken } from "../secrets.js";
import { getScheduledEntryNextRunAt, listScheduledEntries, removeUserJob, setUserJobDisabled } from "../scheduler.js";
import { renderHome, renderJobsPage, renderSettings } from "./views.js";
import { validateUserSlug } from "./validate.js";
import type { WebRouteDeps } from "./types.js";

export function registerSecretsRoutes(app: Hono, deps: WebRouteDeps) {
  const settingsView = (csrfToken: string, error?: string) => renderSettings(
    getTelegramBotToken(deps.getVault()),
    getSteveVersion(),
    csrfToken,
    getSystemTimezone(),
    error,
  );

  app.get("/", async (c) => {
    const session = deps.requireAdminPage(c);
    if (session instanceof Response) return session;

    const health = await getHealth();
    return c.html(renderHome(health, session.csrfToken));
  });

  app.get("/settings", (c) => {
    const session = deps.requireAdminPage(c);
    if (session instanceof Response) return session;
    return c.html(settingsView(session.csrfToken));
  });

  app.post("/settings/telegram", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const vault = deps.getVault();
    if (!vault) return c.redirect("/");

    const existingToken = getTelegramBotToken(vault) || "";
    const submittedToken = String(result.body.bot_token || "").trim();
    const nextToken = submittedToken || existingToken;

    if (!nextToken) {
        return c.html(settingsView(result.session.csrfToken, "Bot token is required"), 400);
    }

    try {
      const res = await deps.telegramFetch(`${getTelegramApiBase()}/bot${String(nextToken)}/getMe`);
      const data = await res.json() as { ok: boolean };
      if (!data.ok) {
          return c.html(settingsView(result.session.csrfToken, "Telegram bot token looks invalid"), 400);
      }
    } catch {
      return c.html(settingsView(result.session.csrfToken, "Telegram bot token looks invalid"), 400);
    }

    setTelegramBotToken(vault, nextToken);
    refreshRuntimeConfigFromVault(vault);
    return c.redirect("/settings");
  });

  app.post("/settings/timezone", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const timezone = String(result.body.timezone || "").trim();
    if (!timezone || !isValidTimezone(timezone)) {
      return c.html(renderSettings(getTelegramBotToken(deps.getVault()), getSteveVersion(), result.session.csrfToken, timezone || getSystemTimezone(), "Timezone must look like Europe/Stockholm"), 400);
    }

    writeSystemSettings({ timezone });
    return c.redirect("/settings");
  });

  app.get("/jobs", (c) => {
    const session = deps.requireAdminPage(c);
    if (session instanceof Response) return session;

    const entries = listScheduledEntries().map((entry) => ({
      ...entry,
      nextRunAt: getScheduledEntryNextRunAt(entry),
    }));
    return c.html(renderJobsPage(entries, session.csrfToken));
  });

  app.post("/jobs/toggle", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const validatedUser = validateUserSlug(String(result.body.user || ""));
    if (!validatedUser.ok) return c.redirect("/jobs");

    const id = String(result.body.id || "");
    const disabled = String(result.body.disabled || "") === "true";
    if (id) {
      setUserJobDisabled(validatedUser.value, id, disabled);
    }
    return c.redirect("/jobs");
  });

  app.post("/jobs/delete", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const validatedUser = validateUserSlug(String(result.body.user || ""));
    if (!validatedUser.ok) return c.redirect("/jobs");

    const id = String(result.body.id || "");
    if (id) {
      removeUserJob(validatedUser.value, id);
    }
    return c.redirect("/jobs");
  });
}
