import type { Hono } from "hono";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { getHealth } from "../health.js";
import { config, getKellixVersion, getSystemTimezone, getTelegramApiBase, isValidTimezone, refreshRuntimeConfigFromVault, writeSystemSettings } from "../config.js";
import { getTelegramBotToken, listUserAppSecrets, setTelegramBotToken } from "../secrets.js";
import { getScheduledEntryNextRunAt, listScheduledEntries, removeUserJob, setUserJobDisabled, upsertUserJob } from "../scheduler.js";
import { normalizeAgentId, readUserAgentsConfig } from "../user-agents.js";
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

  app.post("/settings/restart", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    // Schedule the restart after the response is sent so the redirect lands in
    // the browser before docker tears the container down.
    setTimeout(() => {
      try {
        const hostname = (process.env.HOSTNAME || readFileSync("/etc/hostname", "utf-8").trim()).trim();
        if (!hostname) return;
        const child = spawn("docker", ["restart", hostname], { detached: true, stdio: "ignore" });
        child.unref();
      } catch (err) {
        console.error("Failed to restart kellix:", err instanceof Error ? err.message : err);
      }
    }, 500);

    // Marker cookie so the settings page polls itself back online after reload.
    c.header("Set-Cookie", "kellix_restarting=1; Path=/; Max-Age=30");
    setFlash(c, "Restarting Kellix… page will reload in a few seconds");
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
      memberAgents: Object.keys(readUsersFromVault(deps.getVault())).sort().map((userName) => ({
        userName,
        agents: readUserAgentsConfig(userName).agents.map((agent) => ({ id: agent.id, name: agent.name })),
      })),
    }));
  });

  app.post("/jobs", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const [rawUser, rawAgent] = String(result.body.target || "").split(":");
    const validatedUser = validateUserSlug(rawUser || "");
    if (!validatedUser.ok) return c.redirect("/jobs");
    const agentId = normalizeAgentId(rawAgent || "kellix");
    const id = String(result.body.id || "").trim();
    const name = String(result.body.name || "").trim();
    const prompt = String(result.body.prompt || "").trim();
    const cron = String(result.body.cron || "").trim();
    const at = String(result.body.at || "").trim();
    const timezone = String(result.body.timezone || "").trim();
    if (!id || !name || !prompt || (!cron && !at)) {
      setFlash(c, "Task needs ID, name, prompt, and either cron or one-off time", "error");
      return c.redirect("/jobs");
    }
    upsertUserJob(validatedUser.value, {
      id,
      agentId,
      name,
      prompt,
      ...(cron ? { cron } : {}),
      ...(at ? { at } : {}),
      ...(timezone ? { timezone } : {}),
    });
    setFlash(c, "Task saved");
    return c.redirect("/jobs");
  });

  app.post("/jobs/toggle", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const validatedUser = validateUserSlug(String(result.body.user || ""));
    if (!validatedUser.ok) return c.redirect("/jobs");

    const id = String(result.body.id || "");
    const agentId = normalizeAgentId(String(result.body.agent || "kellix"));
    const disabled = String(result.body.disabled || "") === "true";
    if (id) {
      setUserJobDisabled(validatedUser.value, id, disabled, agentId);
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
    const agentId = normalizeAgentId(String(result.body.agent || "kellix"));
    if (id) {
      removeUserJob(validatedUser.value, id, agentId);
      setFlash(c, "Task deleted");
    }
    return c.redirect("/jobs");
  });
}
