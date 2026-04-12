import type { Hono } from "hono";
import { getHealth } from "../health.js";
import { config, getKellixVersion, getSystemTimezone, getTelegramApiBase, isValidTimezone, refreshRuntimeConfigFromVault, writeSystemSettings } from "../config.js";
import { getTelegramBotToken, listUserAppSecrets, setTelegramBotToken } from "../secrets.js";
import { getScheduledEntryNextRunAt, listScheduledEntries, removeUserJob, setUserJobDisabled } from "../scheduler.js";
import { getTelegramChatId, readUsersFromVault } from "../users.js";
import { readUserActivity } from "../activity.js";
import { renderHome, renderJobsPage, renderSettings, type JobsFilterStatus, type MemberSummary } from "./views.js";
import { validateUserSlug } from "./validate.js";
import type { WebRouteDeps } from "./types.js";
import { setFlash } from "./flash.js";

export function registerSecretsRoutes(app: Hono, deps: WebRouteDeps) {
  const settingsView = (csrfToken: string, error?: string) => renderSettings(
    getTelegramBotToken(deps.getVault()),
    getKellixVersion(),
    csrfToken,
    getSystemTimezone(),
    error,
  );

  app.get("/", async (c) => {
    const session = deps.requireAdminPage(c);
    if (session instanceof Response) return session;

    const health = await getHealth();
    const vault = deps.getVault();
    const users = readUsersFromVault(vault);

    // Build a per-member summary for the home grid. Order matches the
    // health.opencode key order so the grid stays stable across reloads.
    const memberNames = Object.keys(health.components.opencode);
    const members: MemberSummary[] = memberNames.map((name) => {
      const recent = readUserActivity(config.dataDir, name, 1);
      return {
        name,
        status: health.components.opencode[name]?.status ?? "paused",
        integrationCount: listUserAppSecrets(vault, name).length,
        telegramConnected: !!getTelegramChatId(users, name),
        lastActivityAt: recent[0]?.timestamp ?? null,
      };
    });

    return c.html(renderHome({
      health,
      members,
      csrfToken: session.csrfToken,
    }));
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
    setFlash(c, "Telegram bot token saved");
    return c.redirect("/settings");
  });

  app.post("/settings/timezone", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const timezone = String(result.body.timezone || "").trim();
    if (!timezone || !isValidTimezone(timezone)) {
      return c.html(renderSettings(getTelegramBotToken(deps.getVault()), getKellixVersion(), result.session.csrfToken, timezone || getSystemTimezone(), "Timezone must look like Europe/Stockholm"), 400);
    }

    writeSystemSettings({ timezone });
    setFlash(c, `Timezone set to ${timezone}`);
    return c.redirect("/settings");
  });

  app.get("/jobs", (c) => {
    const session = deps.requireAdminPage(c);
    if (session instanceof Response) return session;

    const rawStatus = String(c.req.query("status") || "all");
    const filterStatus: JobsFilterStatus = rawStatus === "active" || rawStatus === "paused" ? rawStatus : "all";
    const filterMember = String(c.req.query("member") || "all");

    const allEntries = listScheduledEntries();
    // Build the member list for the filter chips from the unfiltered set
    // so chips don't disappear once you've filtered down to one.
    const memberNames = Array.from(new Set(allEntries.map((e) => e.userName))).sort();

    const filtered = allEntries.filter((entry) => {
      if (filterMember !== "all" && entry.userName !== filterMember) return false;
      if (filterStatus === "active" && entry.kind === "job" && entry.disabled) return false;
      if (filterStatus === "paused" && !(entry.kind === "job" && entry.disabled)) return false;
      return true;
    });

    const entries = filtered.map((entry) => ({
      ...entry,
      nextRunAt: getScheduledEntryNextRunAt(entry),
    }));

    return c.html(renderJobsPage({
      entries,
      csrfToken: session.csrfToken,
      filterStatus,
      filterMember,
      memberNames,
    }));
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
      setFlash(c, disabled ? "Task paused" : "Task resumed");
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
      setFlash(c, "Task deleted");
    }
    return c.redirect("/jobs");
  });
}
