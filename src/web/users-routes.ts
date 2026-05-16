import type { Hono } from "hono";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/client";
import {
  readUserAgentState,
  removeUserAgentRecord,
  syncUserAgentsRuntime,
  upsertUserAgentRecord,
  writeUserAgentState,
  writeUserAgentsCompose,
} from "../agents.js";
import { APP_SLUG } from "../brand.js";
import { readUserActivity } from "../activity.js";
import { clearAttachedBrowserConfig, readAttachedBrowserConfig, writeAttachedBrowserConfig } from "../browser/attachments.js";
import { getBrowserCompanionStatus } from "../browser/companion-status.js";
import { config, getBaseUrl, getBrowserSettings, getUserAgentDir, getUserDir, refreshRuntimeConfigFromVault } from "../config.js";
import { deleteUserAppSecret, getUserAppSecret, listUserAppSecrets, setAgentTelegramBotToken, setUserAppSecret } from "../secrets.js";
import { generateRuntimeConfig, setupUserWorkspace } from "../setup.js";
import { deleteUserKellixAgent, normalizeAgentId, readUserAgentsConfig, setDefaultUserAgent, updateUserAgentProfile, updateUserAgentTelegram, upsertUserKellixAgent } from "../user-agents.js";
import { addOrUpdateTelegramUser, ensureUser, getTelegramChatId, readUsersFromVault, writeUserManifest, writeUsersToVault } from "../users.js";
import { mergeFieldsWithExistingValue, parseFields, valueToFields } from "./common.js";
import {
  getUserAgentLogs,
  restartUserAgent,
  startUserAgent,
  removeUserAgent,
  getComposeProject,
  updateUserAgentImage,
} from "./docker.js";
import { renderUserAgentDetailPage, renderUserAgentPage, renderUserBrowserPage, renderUserConnections, renderUserHeader, renderUserIntegrationsPage, renderUserSecretEditForm, renderUserSecretNewForm } from "./views.js";
import { escapeHtml } from "./components.js";
import { validateIntegrationSlug, validateTelegramId, validateUserSlug } from "./validate.js";
import type { AdminFormResult, WebRouteDeps } from "./types.js";
import type { Context } from "hono";
import { setFlash } from "./flash.js";

function opencodeBaseUrl(userName: string, agentId: string): string {
  return `http://opencode-${userName}-${agentId}:3456`;
}

export function registerUsersRoutes(app: Hono, deps: WebRouteDeps) {
  function getAgentOpenCodeConfigPath(name: string, agentId: string): string {
    return join(getUserAgentDir(name, agentId), "opencode.json");
  }

  function readAgentOpenCodeConfig(name: string, agentId: string): Record<string, any> {
    const configPath = getAgentOpenCodeConfigPath(name, agentId);
    if (!existsSync(configPath)) return {};
    try {
      return JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, any>;
    } catch {
      return {};
    }
  }

  function inferConfiguredModel(opencodeConfig: Record<string, any>): string | null {
    if (typeof opencodeConfig.model === "string" && opencodeConfig.model.trim()) {
      return opencodeConfig.model;
    }

    const providerEntries = opencodeConfig.provider && typeof opencodeConfig.provider === "object"
      ? Object.entries(opencodeConfig.provider as Record<string, any>)
      : [];

    for (const [providerId, providerConfig] of providerEntries) {
      const models = providerConfig && typeof providerConfig === "object" && providerConfig.models && typeof providerConfig.models === "object"
        ? Object.keys(providerConfig.models)
        : [];
      if (models.length === 1) {
        return `${providerId}/${models[0]}`;
      }
    }

    return null;
  }

  function getConfiguredThinkingLevel(opencodeConfig: Record<string, any>, agentId: string, configuredModel: string | null): string {
    const agentEntry = opencodeConfig.agent?.[agentId];
    return configuredModel && agentEntry && typeof agentEntry === "object" && typeof agentEntry.variant === "string" && agentEntry.variant.trim()
      ? agentEntry.variant
      : "default";
  }

  async function getOpenCodeModelState(name: string, agentId: string): Promise<{
    currentModel: string | null;
    providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string; variants: string[] }> }>;
  }> {
    const oc = createOpencodeClient({
      baseUrl: opencodeBaseUrl(name, agentId),
      directory: "/data",
    });

    const [configRes, providersRes] = await Promise.all([
      oc.config.get({}),
      oc.config.providers({}),
    ]);

    const currentModel = inferConfiguredModel(readAgentOpenCodeConfig(name, agentId)) || (typeof configRes.data?.model === "string" ? configRes.data.model : null);
    const providers = (providersRes.data?.providers || [])
      .map((provider: any) => ({
        id: String(provider.id),
        name: String(provider.name || provider.id),
        models: Object.values(provider.models || {})
          .map((model: any) => ({
            id: String(model.id),
            name: String(model.name || model.id),
            variants: model.variants && typeof model.variants === "object" ? Object.keys(model.variants) : [],
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .filter((provider: { models: Array<{ id: string; name: string; variants: string[] }> }) => provider.models.length > 0)
      .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));

    return { currentModel, providers };
  }

  async function probeAgentStatus(name: string, agentId: string, enabled: boolean): Promise<"running" | "stopped" | "paused" | "unknown"> {
    try {
      const res = await fetch(opencodeBaseUrl(name, agentId), { signal: AbortSignal.timeout(2000) });
      return res.status < 500 ? "running" : "stopped";
    } catch {
      return enabled ? "stopped" : "paused";
    }
  }

  async function getAgentRuntimeState(name: string, agentId: string) {
    const savedConfig = readAgentOpenCodeConfig(name, agentId);
    const stateEntry = readUserAgentState()[name]?.[agentId];
    const agentEnabled = stateEntry?.enabled ?? false;
    const status = await probeAgentStatus(name, agentId, agentEnabled);

    const port = stateEntry?.port || 0;
    const baseUrl = new URL(getBaseUrl());
    const ocUrl = port && agentEnabled ? `http://${baseUrl.hostname}:${port}` : "";

    let currentModel: string | null = inferConfiguredModel(savedConfig);
    let modelProviders: Array<{ id: string; name: string; models: Array<{ id: string; name: string; variants: string[] }> }> = [];

    if (status === "running") {
      try {
        const modelState = await getOpenCodeModelState(name, agentId);
        currentModel = modelState.currentModel || currentModel;
        modelProviders = modelState.providers;
      } catch {
        modelProviders = [];
      }
    }

    return {
      status,
      agentEnabled,
      ocUrl,
      currentModel,
      thinkingLevel: getConfiguredThinkingLevel(savedConfig, agentId, currentModel),
      modelProviders,
    };
  }

  async function getUserPageState(name: string) {
    const userDir = getUserDir(name);
    if (!existsSync(userDir)) return null;
    const kellixRuntime = await getAgentRuntimeState(name, APP_SLUG);

    const users = readUsersFromVault(deps.getVault());
    const browserCompanion = await getBrowserCompanionStatus();
    const kellixAgentsConfig = readUserAgentsConfig(name);

    return {
      ocStatus: kellixRuntime.status,
      agentEnabled: kellixRuntime.agentEnabled,
      ocUrl: kellixRuntime.ocUrl,
      currentModel: kellixRuntime.currentModel,
      thinkingLevel: kellixRuntime.thinkingLevel,
      modelProviders: kellixRuntime.modelProviders,
      opencodeImage: process.env.KELLIX_OPENCODE_IMAGE || "ghcr.io/robertbrunhage/kellix-opencode:main",
      attachedBrowser: readAttachedBrowserConfig(name),
      remoteBrowserAvailable: getBrowserSettings().remoteEnabled,
      browserCompanion,
      telegramChatId: getTelegramChatId(users, name),
      userSecrets: listUserAppSecrets(deps.getVault(), name),
      recentActivity: readUserActivity(config.dataDir, name, 6),
      kellixAgents: kellixAgentsConfig.agents,
      defaultAgentId: kellixAgentsConfig.defaultAgentId,
    };
  }

  function enableAgent(userName: string, agentId: string): { port: number } {
    setupUserWorkspace(userName);
    const next = upsertUserAgentRecord(readUserAgentState(), userName, agentId, { enabled: true });
    writeUserAgentState(next);
    writeUserAgentsCompose(next);
    const port = next[userName]?.[agentId]?.port || 0;
    return { port };
  }

  function disableAgent(userName: string, agentId: string): void {
    const next = upsertUserAgentRecord(readUserAgentState(), userName, agentId, { enabled: false });
    writeUserAgentState(next);
    writeUserAgentsCompose(next);
  }

  function deregisterAgent(userName: string, agentId: string): void {
    const next = removeUserAgentRecord(readUserAgentState(), userName, agentId);
    writeUserAgentState(next);
    writeUserAgentsCompose(next);
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

    const existing = readUsersFromVault(vault);
    const updatedUsers = ensureUser(existing, validatedName.value);
    writeUsersToVault(vault, updatedUsers);
    refreshRuntimeConfigFromVault(vault);
    setupUserWorkspace(validatedName.value);
    generateRuntimeConfig(updatedUsers);
    syncUserAgentsRuntime(updatedUsers);
    writeUserManifest(config.dataDir, updatedUsers);
    setFlash(c, `Member ${validatedName.value} added`);
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
      setFlash(c, "Telegram chat ID looks invalid", "error");
      return c.redirect(`/users/${c.req.param("name")}`);
    }

    const existing = readUsersFromVault(vault);
    const updatedUsers = addOrUpdateTelegramUser(existing, validatedName.value, telegramId);
    writeUsersToVault(vault, updatedUsers);
    refreshRuntimeConfigFromVault(vault);
    writeUserManifest(config.dataDir, updatedUsers);
    setFlash(c, "Telegram chat linked");
    return c.redirect(`/users/${validatedName.value}`);
  });

  app.post("/users/:name/browser/attach", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    const rawChannel = String(result.body.channel || "stable").trim();
    const channel = rawChannel === "beta" || rawChannel === "dev" || rawChannel === "canary" ? rawChannel : "stable";
    writeAttachedBrowserConfig(validatedName.value, { channel });
    setFlash(c, `Browser attached (${channel})`);
    return c.redirect(`/users/${validatedName.value}/browser`);
  });

  app.post("/users/:name/browser/detach", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    clearAttachedBrowserConfig(validatedName.value);
    setFlash(c, "Browser detached");
    return c.redirect(`/users/${validatedName.value}/browser`);
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
    setFlash(c, `${validatedIntegration.value} saved`);
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
    setFlash(c, `${validatedIntegration.value} updated`);
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
    setFlash(c, `${validatedIntegration.value} removed`);
    return c.redirect(`/users/${validatedName.value}/integrations`);
  });

  async function respondAfterAgentMutation(c: Context, result: AdminFormResult, name: string): Promise<Response> {
    if (c.req.header("HX-Request")) {
      const state = await getUserPageState(name);
      if (state) {
        return c.html(renderUserHeader(name, state.ocStatus, state.agentEnabled, result.session.csrfToken));
      }
    }
    return c.redirect(`/users/${name}`);
  }

  // Member-level runtime controls operate on the kellix (default) agent.

  app.post("/users/:name/start", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    const name = validatedName.value;

    let started = true;
    try {
      enableAgent(name, APP_SLUG);
      startUserAgent(deps.composeProject, name, APP_SLUG);
    } catch (err) {
      started = false;
      console.error("Failed to start agent:", err instanceof Error ? err.message : err);
    }

    setFlash(c, started ? `${name}'s agent started` : "Failed to start agent", started ? "ok" : "error");
    return respondAfterAgentMutation(c, result, name);
  });

  app.post("/users/:name/stop", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    const name = validatedName.value;
    try {
      disableAgent(name, APP_SLUG);
      removeUserAgent(deps.composeProject, name, APP_SLUG);
    } catch {}
    setFlash(c, `${name}'s agent stopped`);
    return respondAfterAgentMutation(c, result, name);
  });

  app.post("/users/:name/restart", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    const name = validatedName.value;
    try {
      restartUserAgent(deps.composeProject, name, APP_SLUG);
    } catch {}
    setFlash(c, `${name}'s agent restarted`);
    return respondAfterAgentMutation(c, result, name);
  });

  app.post("/users/:name/update-opencode", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    const name = validatedName.value;

    try {
      const state = readUserAgentState()[name]?.[APP_SLUG];
      if (!state?.enabled) enableAgent(name, APP_SLUG);
      updateUserAgentImage(deps.composeProject, name, APP_SLUG);
      setFlash(c, "OpenCode image updated and agent restarted");
    } catch (err) {
      console.error("Failed to update OpenCode image:", err instanceof Error ? err.message : err);
      setFlash(c, "Failed to update OpenCode image", "error");
    }

    return c.redirect(`/users/${name}/agent`);
  });

  // Per-agent runtime controls.

  app.post("/users/:name/agents/:agent/start", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;
    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    const agentId = normalizeAgentId(String(c.req.param("agent") || ""));
    try {
      enableAgent(validatedName.value, agentId);
      startUserAgent(deps.composeProject, validatedName.value, agentId);
      setFlash(c, `Agent ${agentId} started`);
    } catch (err) {
      setFlash(c, `Failed to start ${agentId}: ${err instanceof Error ? err.message : err}`, "error");
    }
    return c.redirect(`/users/${validatedName.value}/agents/${encodeURIComponent(agentId)}`);
  });

  app.post("/users/:name/agents/:agent/stop", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;
    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    const agentId = normalizeAgentId(String(c.req.param("agent") || ""));
    try {
      disableAgent(validatedName.value, agentId);
      removeUserAgent(deps.composeProject, validatedName.value, agentId);
      setFlash(c, `Agent ${agentId} stopped`);
    } catch {}
    return c.redirect(`/users/${validatedName.value}/agents/${encodeURIComponent(agentId)}`);
  });

  app.post("/users/:name/agents/:agent/update-opencode", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;
    const validatedName = validateUserSlug(c.req.param("name") || "");
    if (!validatedName.ok) return c.redirect("/");
    const agentId = normalizeAgentId(String(c.req.param("agent") || ""));
    try {
      const state = readUserAgentState()[validatedName.value]?.[agentId];
      if (!state?.enabled) enableAgent(validatedName.value, agentId);
      updateUserAgentImage(deps.composeProject, validatedName.value, agentId);
      setFlash(c, "OpenCode image updated and agent restarted");
    } catch (err) {
      setFlash(c, `Failed to update: ${err instanceof Error ? err.message : err}`, "error");
    }
    return c.redirect(`/users/${validatedName.value}/agents/${encodeURIComponent(agentId)}`);
  });

  app.post("/users/:name/agents/:agent/restart", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;
    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    const agentId = normalizeAgentId(String(c.req.param("agent") || ""));
    try {
      restartUserAgent(deps.composeProject, validatedName.value, agentId);
      setFlash(c, `Agent ${agentId} restarted`);
    } catch {}
    return c.redirect(`/users/${validatedName.value}/agents/${encodeURIComponent(agentId)}`);
  });

  // Agent CRUD.

  app.post("/users/:name/agents", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const validatedName = validateUserSlug(String(c.req.param("name") || ""));
    if (!validatedName.ok) return c.redirect("/");

    const id = normalizeAgentId(String(result.body.id || ""));
    const name = String(result.body.name || "").trim();
    if (!id || !name) {
      setFlash(c, "Agent ID and name are required", "error");
      return c.redirect(`/users/${validatedName.value}/agent`);
    }

    upsertUserKellixAgent(validatedName.value, { id, name, goal: "", setupStatus: "needs_setup" });
    const users = readUsersFromVault(deps.getVault());
    setupUserWorkspace(validatedName.value);
    generateRuntimeConfig(users);
    try {
      enableAgent(validatedName.value, id);
      startUserAgent(deps.composeProject, validatedName.value, id);
    } catch (err) {
      console.error(`Could not start specialist agent ${id}:`, err instanceof Error ? err.message : err);
    }
    setFlash(c, `Agent ${name} created`);
    return c.redirect(`/users/${validatedName.value}/agent`);
  });

  app.post("/users/:name/agents/:agent", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;
    const validatedName = validateUserSlug(String(c.req.param("name") || ""));
    if (!validatedName.ok) return c.redirect("/");
    const agentId = normalizeAgentId(String(c.req.param("agent") || ""));
    const existing = readUserAgentsConfig(validatedName.value).agents.find((agent) => agent.id === agentId);
    if (!existing) return c.redirect(`/users/${validatedName.value}/agent`);
    const name = String(result.body.name || "").trim();
    const roleSummary = String(result.body.roleSummary || "").trim();
    const instructions = String(result.body.instructions || "").trim();
    if (!name) {
      setFlash(c, "Agent name is required", "error");
      return c.redirect(`/users/${validatedName.value}/agent`);
    }
    upsertUserKellixAgent(validatedName.value, {
      ...existing,
      name,
      roleSummary,
      instructions,
      goal: roleSummary,
      setupStatus: roleSummary || instructions ? "configured" : "needs_setup",
    });
    updateUserAgentProfile(validatedName.value, agentId, { roleSummary, instructions, setupStatus: roleSummary || instructions ? "configured" : "needs_setup" });
    generateRuntimeConfig(readUsersFromVault(deps.getVault()));
    setFlash(c, "Agent saved");
    return c.redirect(`/users/${validatedName.value}/agents/${encodeURIComponent(agentId)}`);
  });

  app.post("/users/:name/agents/:agent/reset-setup", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;
    const validatedName = validateUserSlug(String(c.req.param("name") || ""));
    if (!validatedName.ok) return c.redirect("/");
    const resetAgentId = normalizeAgentId(String(c.req.param("agent") || ""));
    updateUserAgentProfile(validatedName.value, resetAgentId, { roleSummary: "", instructions: "", setupStatus: "needs_setup" });
    generateRuntimeConfig(readUsersFromVault(deps.getVault()));
    setFlash(c, "Agent setup reset");
    return c.redirect(`/users/${validatedName.value}/agents/${encodeURIComponent(resetAgentId)}`);
  });

  app.post("/users/:name/agents/:agent/default", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;
    const validatedName = validateUserSlug(String(c.req.param("name") || ""));
    if (!validatedName.ok) return c.redirect("/");
    setDefaultUserAgent(validatedName.value, String(c.req.param("agent") || ""));
    setFlash(c, "Default agent updated");
    return c.redirect(`/users/${validatedName.value}/agent`);
  });

  app.post("/users/:name/agents/:agent/delete", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;
    const validatedName = validateUserSlug(String(c.req.param("name") || ""));
    if (!validatedName.ok) return c.redirect("/");
    const agentId = normalizeAgentId(String(c.req.param("agent") || ""));
    try {
      removeUserAgent(deps.composeProject, validatedName.value, agentId);
    } catch {}
    deregisterAgent(validatedName.value, agentId);
    deleteUserKellixAgent(validatedName.value, agentId);
    generateRuntimeConfig(readUsersFromVault(deps.getVault()));
    setFlash(c, "Agent deleted");
    return c.redirect(`/users/${validatedName.value}/agent`);
  });

  app.post("/users/:name/agents/:agent/telegram", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const validatedName = validateUserSlug(String(c.req.param("name") || ""));
    if (!validatedName.ok) return c.redirect("/");
    const agentId = normalizeAgentId(String(c.req.param("agent") || ""));
    const botToken = String(result.body.bot_token || "").trim();
    const chatId = String(result.body.chat_id || "").trim();
    if (chatId && !validateTelegramId(chatId)) {
      setFlash(c, "Telegram chat ID must be numeric", "error");
      return c.redirect(`/users/${validatedName.value}/agent`);
    }
    updateUserAgentTelegram(validatedName.value, agentId, {
      chatId,
    });
    if (botToken) {
      const vault = deps.getVault();
      if (!vault) {
        setFlash(c, "Vault is locked", "error");
        return c.redirect(`/users/${validatedName.value}/agents/${encodeURIComponent(agentId)}`);
      }
      setAgentTelegramBotToken(vault, validatedName.value, agentId, botToken);
    }
    setFlash(c, "Agent Telegram settings saved");
    return c.redirect(`/users/${validatedName.value}/agents/${encodeURIComponent(agentId)}`);
  });

  // Member detail pages.

  app.get("/users/:name", async (c) => {
    const session = deps.requireAdminPage(c);
    if (session instanceof Response) return session;

    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    const name = validatedName.value;
    const state = await getUserPageState(name);
    if (!state) return c.redirect("/");
    return c.html(renderUserConnections(name, state.ocStatus, session.csrfToken, state));
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

  app.get("/users/:name/browser", async (c) => {
    const session = deps.requireAdminPage(c);
    if (session instanceof Response) return session;

    const name = c.req.param("name");
    const state = await getUserPageState(name);
    if (!state) return c.redirect("/");
    return c.html(renderUserBrowserPage(name, state.ocStatus, session.csrfToken, state));
  });

  app.get("/users/:name/agent", async (c) => {
    const session = deps.requireAdminPage(c);
    if (session instanceof Response) return session;

    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    const state = await getUserPageState(validatedName.value);
    if (!state) return c.redirect("/");
    return c.html(renderUserAgentPage(validatedName.value, state.ocStatus, state.ocUrl, session.csrfToken, state));
  });

  app.get("/users/:name/agents/:agent", async (c) => {
    const session = deps.requireAdminPage(c);
    if (session instanceof Response) return session;

    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    const name = validatedName.value;
    const agentId = normalizeAgentId(String(c.req.param("agent") || ""));
    const agentsConfig = readUserAgentsConfig(name);
    const agent = agentsConfig.agents.find((entry) => entry.id === agentId);
    if (!agent) return c.redirect(`/users/${name}/agent`);

    const runtime = await getAgentRuntimeState(name, agentId);
    return c.html(renderUserAgentDetailPage({
      userName: name,
      agent,
      defaultAgentId: agentsConfig.defaultAgentId,
      csrfToken: session.csrfToken,
      runtime,
      opencodeImage: process.env.KELLIX_OPENCODE_IMAGE || "ghcr.io/robertbrunhage/kellix-opencode:main",
    }));
  });

  // --- Workflows ------------------------------------------------------------

  app.get("/users/:name/agents/:agent/workflows", async (c) => {
    const session = deps.requireAdminPage(c);
    if (session instanceof Response) return session;
    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    const name = validatedName.value;
    const agentId = normalizeAgentId(String(c.req.param("agent") || ""));
    const { listWorkflows, listInstances } = await import("../workflows/storage.js");
    const workflows = listWorkflows(name, agentId);
    const recentRuns = listInstances(name, agentId, { limit: 20 });
    const { renderWorkflowsList } = await import("./views/workflows.js");
    return c.html(renderWorkflowsList({ userName: name, agentId, workflows, recentRuns, csrfToken: session.csrfToken }));
  });

  app.get("/users/:name/agents/:agent/workflows/:wf", async (c) => {
    const session = deps.requireAdminPage(c);
    if (session instanceof Response) return session;
    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    const name = validatedName.value;
    const agentId = normalizeAgentId(String(c.req.param("agent") || ""));
    const wfName = String(c.req.param("wf") || "");
    const { readWorkflow, listInstances } = await import("../workflows/storage.js");
    const workflow = readWorkflow(name, agentId, wfName);
    if (!workflow) return c.redirect(`/users/${name}/agents/${agentId}/workflows`);
    const runs = listInstances(name, agentId, { workflowName: wfName, limit: 10 });
    const { renderWorkflowDetail } = await import("./views/workflows.js");
    return c.html(renderWorkflowDetail({ userName: name, agentId, workflow, runs, csrfToken: session.csrfToken }));
  });

  app.get("/users/:name/agents/:agent/workflows/:wf/runs/:id", async (c) => {
    const session = deps.requireAdminPage(c);
    if (session instanceof Response) return session;
    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    const name = validatedName.value;
    const agentId = normalizeAgentId(String(c.req.param("agent") || ""));
    const wfName = String(c.req.param("wf") || "");
    const id = String(c.req.param("id") || "");
    const { readWorkflow, readInstance } = await import("../workflows/storage.js");
    const workflow = readWorkflow(name, agentId, wfName);
    const instance = readInstance(name, agentId, id);
    if (!workflow || !instance) return c.redirect(`/users/${name}/agents/${agentId}/workflows`);
    const { renderWorkflowRun } = await import("./views/workflows.js");
    return c.html(renderWorkflowRun({ userName: name, agentId, workflow, instance, csrfToken: session.csrfToken }));
  });

  app.post("/users/:name/agents/:agent/workflows/:wf/run", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;
    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    const name = validatedName.value;
    const agentId = normalizeAgentId(String(c.req.param("agent") || ""));
    const wfName = String(c.req.param("wf") || "");
    const engine = deps.workflowEngine;
    if (!engine) {
      setFlash(c, "Workflow engine not available", "error");
      return c.redirect(`/users/${name}/agents/${agentId}/workflows/${wfName}`);
    }
    engine.runByName(name, agentId, wfName, { triggerKind: "manual" }).catch((err) => {
      console.error(`Manual workflow run failed: ${err instanceof Error ? err.message : err}`);
    });
    setFlash(c, "Workflow started");
    return c.redirect(`/users/${name}/agents/${agentId}/workflows/${wfName}`);
  });

  app.post("/users/:name/agents/:agent/workflows/:wf/runs/:id/approve", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;
    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    const name = validatedName.value;
    const agentId = normalizeAgentId(String(c.req.param("agent") || ""));
    const wfName = String(c.req.param("wf") || "");
    const id = String(c.req.param("id") || "");
    const response = String(result.body.response || "");
    const engine = deps.workflowEngine;
    if (!engine) {
      setFlash(c, "Workflow engine not available", "error");
      return c.redirect(`/users/${name}/agents/${agentId}/workflows/${wfName}/runs/${id}`);
    }
    const ok = engine.resume({ instanceId: id, response, approvedBy: "admin" });
    setFlash(c, ok ? `Resumed with ${response}` : "No pending approval to resume", ok ? "ok" : "error");
    return c.redirect(`/users/${name}/agents/${agentId}/workflows/${wfName}/runs/${id}`);
  });

  // PUBLIC webhook endpoint — does NOT require admin auth, since it's meant
  // to be hit by external systems (CI, Cloudflare, monitoring). The workflow's
  // YAML must declare `triggers: [{ webhook: true }]` to opt in; an optional
  // `webhook_token` value in the trigger is enforced via X-Webhook-Token.
  app.post("/wf/:name/:agent/:workflow", async (c) => {
    const validatedName = validateUserSlug(String(c.req.param("name") || ""));
    if (!validatedName.ok) return c.json({ error: "invalid user" }, 400);
    const name = validatedName.value;
    const agentId = normalizeAgentId(String(c.req.param("agent") || ""));
    const wfName = String(c.req.param("workflow") || "");
    const engine = deps.workflowEngine;
    if (!engine) return c.json({ error: "workflow engine not available" }, 503);

    const { readWorkflow } = await import("../workflows/storage.js");
    const def = readWorkflow(name, agentId, wfName);
    if (!def) return c.json({ error: "workflow not found" }, 404);

    const webhookTrigger = (def.triggers ?? []).find((t) => !!t.webhook);
    if (!webhookTrigger) return c.json({ error: "workflow does not declare a webhook trigger" }, 403);

    // If the trigger's webhook value looks like a token (non-empty, non-"true"),
    // require it as the X-Webhook-Token header.
    const expectedToken = typeof webhookTrigger.webhook === "string" && webhookTrigger.webhook !== "true" && webhookTrigger.webhook.length > 0
      ? webhookTrigger.webhook
      : undefined;
    if (expectedToken) {
      const provided = c.req.header("x-webhook-token") || c.req.header("X-Webhook-Token");
      if (provided !== expectedToken) return c.json({ error: "invalid webhook token" }, 401);
    }

    // Parse body as args. Accept either JSON or query string.
    let args: Record<string, unknown> = {};
    const contentType = c.req.header("content-type") || "";
    if (contentType.includes("application/json")) {
      try { args = await c.req.json() as Record<string, unknown>; } catch {}
    } else {
      const formArgs = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
      args = formArgs as Record<string, unknown>;
    }

    try {
      const inst = await engine.runByName(name, agentId, wfName, {
        args,
        triggerKind: "webhook",
        triggerMeta: { headers: Object.fromEntries(Object.entries(c.req.header())) },
      });
      return c.json({ instanceId: inst.id, status: inst.status, output: inst.output });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/users/:name/agent/model", async (c) => {
    return saveAgentModel(c, APP_SLUG);
  });

  app.post("/users/:name/agents/:agent/model", async (c) => {
    const agentId = normalizeAgentId(String(c.req.param("agent") || ""));
    return saveAgentModel(c, agentId);
  });

  async function saveAgentModel(c: Context, agentId: string): Promise<Response> {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const validatedName = validateUserSlug(c.req.param("name") || "");
    if (!validatedName.ok) return c.redirect("/");
    const name = validatedName.value;

    const submittedProviderId = String(result.body.provider_id || "").trim();
    const submittedModelId = String(result.body.model_id || "").trim();
    const submittedThinkingLevel = String(result.body.thinking_level || "default").trim();
    if (!submittedProviderId || !submittedModelId) {
      return c.redirect(`/users/${name}/agent`);
    }

    const providerId = submittedModelId.includes("/")
      ? submittedModelId.split("/")[0] || submittedProviderId
      : submittedProviderId;
    const modelId = submittedModelId.includes("/")
      ? submittedModelId.slice(submittedModelId.indexOf("/") + 1)
      : submittedModelId;
    const configuredModel = submittedModelId.includes("/") ? submittedModelId : `${providerId}/${modelId}`;

    const opencodePath = getAgentOpenCodeConfigPath(name, agentId);
    const nextConfig = readAgentOpenCodeConfig(name, agentId);
    nextConfig.model = configuredModel;

    if (providerId === "local" || providerId === "ollama") {
      const providers = nextConfig.provider && typeof nextConfig.provider === "object"
        ? nextConfig.provider as Record<string, any>
        : {};
      const existingProvider = providers[providerId] && typeof providers[providerId] === "object"
        ? providers[providerId] as Record<string, any>
        : {};
      const existingModels = existingProvider.models && typeof existingProvider.models === "object"
        ? existingProvider.models as Record<string, any>
        : {};

      nextConfig.provider = {
        ...providers,
        [providerId]: {
          npm: "@ai-sdk/openai-compatible",
          name: providerId === "ollama" ? "Ollama (local)" : "local",
          ...existingProvider,
          options: {
            ...(existingProvider.options && typeof existingProvider.options === "object" ? existingProvider.options : {}),
            baseURL: "http://host.docker.internal:11434/v1",
          },
          models: {
            ...existingModels,
            [modelId]: {
              ...(existingModels[modelId] && typeof existingModels[modelId] === "object" ? existingModels[modelId] : {}),
              name: modelId,
            },
          },
        },
      };
    }

    const agentNode = nextConfig.agent && typeof nextConfig.agent === "object" ? nextConfig.agent as Record<string, any> : {};
    const agentEntry = agentNode[agentId] && typeof agentNode[agentId] === "object" ? agentNode[agentId] as Record<string, any> : {};
    const nextAgentEntry: Record<string, any> = { ...agentEntry, model: configuredModel };
    delete nextAgentEntry.variant;
    if (submittedThinkingLevel !== "default") {
      nextAgentEntry.variant = submittedThinkingLevel;
    }
    nextConfig.agent = { ...agentNode, [agentId]: nextAgentEntry };

    writeFileSync(opencodePath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf-8");

    const runtime = readUserAgentState()[name]?.[agentId];
    if (runtime?.enabled) {
      try {
        restartUserAgent(getComposeProject(), name, agentId);
      } catch {
        try { startUserAgent(getComposeProject(), name, agentId); } catch {}
      }
    }
    setFlash(c, `Model set to ${configuredModel}`);
    return c.redirect(agentId === APP_SLUG ? `/users/${name}/agent` : `/users/${name}/agents/${encodeURIComponent(agentId)}`);
  }

  app.get("/users/:name/logs", (c) => {
    return fetchAgentLogs(c, c.req.param("name"), APP_SLUG);
  });

  app.get("/users/:name/agents/:agent/logs", (c) => {
    return fetchAgentLogs(c, c.req.param("name"), normalizeAgentId(String(c.req.param("agent") || "")));
  });

  function fetchAgentLogs(c: Context, rawName: string | undefined, agentId: string): Response {
    const session = deps.requireAdminApi(c);
    if (session instanceof Response) return session;
    const validatedName = validateUserSlug(rawName || "");
    if (!validatedName.ok) return c.html("Invalid user", 400);
    try {
      const logs = getUserAgentLogs(deps.composeProject, validatedName.value, agentId) || "No logs";
      return c.html(escapeHtml(logs));
    } catch (err) {
      return c.html(escapeHtml(err instanceof Error ? err.message : "Could not fetch logs"));
    }
  }

  app.get("/users/:name/sessions", async (c) => {
    return fetchAgentSessions(c, c.req.param("name"), APP_SLUG);
  });

  app.get("/users/:name/agents/:agent/sessions", async (c) => {
    return fetchAgentSessions(c, c.req.param("name"), normalizeAgentId(String(c.req.param("agent") || "")));
  });

  async function fetchAgentSessions(c: Context, rawName: string | undefined, agentId: string): Promise<Response> {
    const session = deps.requireAdminApi(c);
    if (session instanceof Response) return session;
    const validatedName = validateUserSlug(rawName || "");
    if (!validatedName.ok) return c.json({ error: "Invalid user" }, 400);
    try {
      const res = await fetch(`${opencodeBaseUrl(validatedName.value, agentId)}/session`, {
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
  }
}
