import type { Hono } from "hono";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createOpencodeClient } from "@opencode-ai/sdk/client";
import { readUserAgentState, syncUserAgentsRuntime, upsertUserAgentRecord, writeUserAgentState, writeUserAgentsCompose } from "../agents.js";
import { readUserActivity } from "../activity.js";
import { clearAttachedBrowserConfig, readAttachedBrowserConfig, writeAttachedBrowserConfig } from "../browser/attachments.js";
import { getBrowserCompanionStatus } from "../browser/companion-status.js";
import { config, getBaseUrl, getBrowserSettings, getUserDir, refreshRuntimeConfigFromVault } from "../config.js";
import { deleteUserAppSecret, getUserAppSecret, listUserAppSecrets, setAgentTelegramBotToken, setUserAppSecret } from "../secrets.js";
import { generateRuntimeConfig, setupUserWorkspace } from "../setup.js";
import { deleteUserKellixAgent, normalizeAgentId, readUserAgentsConfig, setDefaultUserAgent, updateUserAgentTelegram, upsertUserKellixAgent } from "../user-agents.js";
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
import { renderUserAgentPage, renderUserBrowserPage, renderUserConnections, renderUserHeader, renderUserIntegrationsPage, renderUserSecretEditForm, renderUserSecretNewForm } from "./views.js";
import { escapeHtml } from "./components.js";
import { validateIntegrationSlug, validateTelegramId, validateUserSlug } from "./validate.js";
import type { AdminFormResult, WebRouteDeps } from "./types.js";
import type { Context } from "hono";
import { setFlash } from "./flash.js";

export function registerUsersRoutes(app: Hono, deps: WebRouteDeps) {
  function getUserOpenCodeConfigPath(name: string): string {
    return `${getUserDir(name)}/opencode.json`;
  }

  function readUserOpenCodeConfig(name: string): Record<string, any> {
    const configPath = getUserOpenCodeConfigPath(name);
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

  function getConfiguredThinkingLevel(opencodeConfig: Record<string, any>, configuredModel: string | null): string {
    const agent = opencodeConfig.agent?.kellix;
    return configuredModel && agent && typeof agent === "object" && typeof agent.variant === "string" && agent.variant.trim()
      ? agent.variant
      : "default";
  }

  async function getOpenCodeModelState(name: string): Promise<{
    currentModel: string | null;
    providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string; variants: string[] }> }>;
  }> {
    const oc = createOpencodeClient({
      baseUrl: `http://opencode-${name}:3456`,
      directory: "/data",
    });

    const [configRes, providersRes] = await Promise.all([
      oc.config.get({}),
      oc.config.providers({}),
    ]);

    const currentModel = inferConfiguredModel(readUserOpenCodeConfig(name)) || (typeof configRes.data?.model === "string" ? configRes.data.model : null);
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

  async function getUserPageState(name: string) {
    const userDir = getUserDir(name);
    if (!existsSync(userDir)) return null;
    const savedConfig = readUserOpenCodeConfig(name);

    let ocStatus = "unknown";
    const agentState = readUserAgentState()[name];
    const agentEnabled = agentState?.enabled ?? false;
    try {
      const res = await fetch(`http://opencode-${name}:3456`, { signal: AbortSignal.timeout(2000) });
      ocStatus = res.status < 500 ? "running" : "stopped";
    } catch {
      ocStatus = agentEnabled ? "stopped" : "paused";
    }

    const ocPort = agentState?.port || 0;
    const baseUrl = new URL(getBaseUrl());
    const ocUrl = ocPort && agentEnabled ? `http://${baseUrl.hostname}:${ocPort}` : "";
    const users = readUsersFromVault(deps.getVault());
    let currentModel: string | null = inferConfiguredModel(savedConfig);
    let modelProviders: Array<{ id: string; name: string; models: Array<{ id: string; name: string; variants: string[] }> }> = [];

    if (ocStatus === "running") {
      try {
        const modelState = await getOpenCodeModelState(name);
        currentModel = modelState.currentModel || currentModel;
        modelProviders = modelState.providers;
      } catch {
        modelProviders = [];
      }
    }

    const browserCompanion = await getBrowserCompanionStatus();
    const kellixAgentsConfig = readUserAgentsConfig(name);

    return {
      ocStatus,
      agentEnabled,
      ocUrl,
      currentModel,
      thinkingLevel: getConfiguredThinkingLevel(savedConfig, currentModel),
      modelProviders,
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

  // Returns the up-to-date user header HTML when the request came from htmx,
  // so start/stop/restart buttons swap their own row in place. Falls back to
  // a normal redirect for non-htmx (e.g. JS disabled).
  async function respondAfterAgentMutation(c: Context, result: AdminFormResult, name: string): Promise<Response> {
    if (c.req.header("HX-Request")) {
      const state = await getUserPageState(name);
      if (state) {
        return c.html(renderUserHeader(name, state.ocStatus, state.agentEnabled, result.session.csrfToken));
      }
    }
    return c.redirect(`/users/${name}`);
  }

  app.post("/users/:name/start", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    const name = validatedName.value;

    let started = true;
    try {
      setupUserWorkspace(name);
      const nextState = upsertUserAgentRecord(readUserAgentState(), name, { enabled: true });
      writeUserAgentState(nextState);
      writeUserAgentsCompose(nextState);
      startUserAgent(deps.composeProject, name);
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
      const nextState = upsertUserAgentRecord(readUserAgentState(), name, { enabled: false });
      writeUserAgentState(nextState);
      writeUserAgentsCompose(nextState);
      removeUserAgent(deps.composeProject, name);
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
      restartUserAgent(deps.composeProject, name);
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
      const state = readUserAgentState()[name];
      if (!state?.enabled) {
        setupUserWorkspace(name);
        const nextState = upsertUserAgentRecord(readUserAgentState(), name, { enabled: true });
        writeUserAgentState(nextState);
        writeUserAgentsCompose(nextState);
      }
      updateUserAgentImage(deps.composeProject, name);
      setFlash(c, "OpenCode image updated and agent restarted");
    } catch (err) {
      console.error("Failed to update OpenCode image:", err instanceof Error ? err.message : err);
      setFlash(c, "Failed to update OpenCode image", "error");
    }

    return c.redirect(`/users/${name}/agent`);
  });

  app.post("/users/:name/agents", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const validatedName = validateUserSlug(String(c.req.param("name") || ""));
    if (!validatedName.ok) return c.redirect("/");

    const id = normalizeAgentId(String(result.body.id || ""));
    const name = String(result.body.name || "").trim();
    const goal = String(result.body.goal || "").trim();
    if (!id || !name || !goal) {
      setFlash(c, "Agent ID, name, and goal are required", "error");
      return c.redirect(`/users/${validatedName.value}/agent`);
    }

    upsertUserKellixAgent(validatedName.value, { id, name, goal });
    const users = readUsersFromVault(deps.getVault());
    generateRuntimeConfig(users);
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
    const goal = String(result.body.goal || "").trim();
    if (!name || !goal) {
      setFlash(c, "Agent name and goal are required", "error");
      return c.redirect(`/users/${validatedName.value}/agent`);
    }
    upsertUserKellixAgent(validatedName.value, { ...existing, name, goal });
    generateRuntimeConfig(readUsersFromVault(deps.getVault()));
    setFlash(c, "Agent saved");
    return c.redirect(`/users/${validatedName.value}/agent`);
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
    deleteUserKellixAgent(validatedName.value, String(c.req.param("agent") || ""));
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
        return c.redirect(`/users/${validatedName.value}/agent`);
      }
      setAgentTelegramBotToken(vault, validatedName.value, agentId, botToken);
    }
    setFlash(c, "Agent Telegram settings saved");
    return c.redirect(`/users/${validatedName.value}/agent`);
  });

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

  app.post("/users/:name/agent/model", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");

    const submittedProviderId = String(result.body.provider_id || "").trim();
    const submittedModelId = String(result.body.model_id || "").trim();
    const submittedThinkingLevel = String(result.body.thinking_level || "default").trim();
    if (!submittedProviderId || !submittedModelId) {
      return c.redirect(`/users/${validatedName.value}/agent`);
    }

    const providerId = submittedModelId.includes("/")
      ? submittedModelId.split("/")[0] || submittedProviderId
      : submittedProviderId;
    const modelId = submittedModelId.includes("/")
      ? submittedModelId.slice(submittedModelId.indexOf("/") + 1)
      : submittedModelId;
    const configuredModel = submittedModelId.includes("/") ? submittedModelId : `${providerId}/${modelId}`;

    const nextConfig = readUserOpenCodeConfig(validatedName.value);
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

    const agent = nextConfig.agent && typeof nextConfig.agent === "object" ? nextConfig.agent as Record<string, any> : {};
    const kellixAgent = agent.kellix && typeof agent.kellix === "object" ? agent.kellix as Record<string, any> : {};
    const nextKellixAgent: Record<string, any> = { ...kellixAgent, model: configuredModel };
    delete nextKellixAgent.variant;
    if (submittedThinkingLevel !== "default") {
      nextKellixAgent.variant = submittedThinkingLevel;
    }
    nextConfig.agent = { ...agent, kellix: nextKellixAgent };

    writeFileSync(getUserOpenCodeConfigPath(validatedName.value), `${JSON.stringify(nextConfig, null, 2)}\n`, "utf-8");
    const state = await getUserPageState(validatedName.value);
    if (state?.agentEnabled) {
      try {
        restartUserAgent(getComposeProject(), validatedName.value);
      } catch {
        startUserAgent(getComposeProject(), validatedName.value);
      }
    }
    setFlash(c, `Model set to ${configuredModel}`);
    return c.redirect(`/users/${validatedName.value}/agent`);
  });

  app.get("/users/:name/logs", (c) => {
    const session = deps.requireAdminApi(c);
    if (session instanceof Response) return session;

    // Returns HTML-escaped log text intended to be swapped into the agent
    // page's `<pre id="logs">` via htmx innerHTML swap. Plain text would risk
    // any `<` in the logs being parsed as a tag.
    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.html("Invalid user", 400);
    try {
      const logs = getUserAgentLogs(deps.composeProject, validatedName.value) || "No logs";
      return c.html(escapeHtml(logs));
    } catch (err) {
      return c.html(escapeHtml(err instanceof Error ? err.message : "Could not fetch logs"));
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
