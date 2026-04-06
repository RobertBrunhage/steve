import type { Hono } from "hono";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createOpencodeClient } from "@opencode-ai/sdk/client";
import { readUserAgentState, syncUserAgentsRuntime, upsertUserAgentRecord, writeUserAgentState, writeUserAgentsCompose } from "../agents.js";
import { readUserActivity } from "../activity.js";
import { clearAttachedBrowserConfig, readAttachedBrowserConfig, writeAttachedBrowserConfig } from "../browser/attachments.js";
import { getBrowserCompanionStatus } from "../browser/companion-status.js";
import { config, getBaseUrl, getBrowserSettings, getUserDir, refreshRuntimeConfigFromVault } from "../config.js";
import { deleteUserAppSecret, getUserAppSecret, listUserAppSecrets, setUserAppSecret } from "../secrets.js";
import { generateRuntimeConfig, setupUserWorkspace } from "../setup.js";
import { addOrUpdateTelegramUser, ensureUser, getTelegramChatId, normalizeUsers, writeUserManifest } from "../users.js";
import { mergeFieldsWithExistingValue, parseFields, valueToFields } from "./common.js";
import {
  getUserAgentLogs,
  restartUserAgent,
  startUserAgent,
  removeUserAgent,
  getComposeProject,
} from "./docker.js";
import { renderUserAgentPage, renderUserBrowserPage, renderUserIntegrationsPage, renderUserOverview, renderUserSecretEditForm, renderUserSecretNewForm } from "./views.js";
import { validateIntegrationSlug, validateTelegramId, validateUserSlug } from "./validate.js";
import type { WebRouteDeps } from "./types.js";

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

  async function getOpenCodeModelState(name: string): Promise<{
    currentModel: string | null;
    providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>;
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
          .map((model: any) => ({ id: String(model.id), name: String(model.name || model.id) }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .filter((provider: { models: Array<{ id: string; name: string }> }) => provider.models.length > 0)
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
      ocStatus = res.ok ? "running" : "stopped";
    } catch {
      ocStatus = agentEnabled ? "stopped" : "paused";
    }

    const ocPort = agentState?.port || 0;
    const baseUrl = new URL(getBaseUrl());
    const ocUrl = ocPort && agentEnabled ? `http://${baseUrl.hostname}:${ocPort}` : "";
    const users = normalizeUsers(deps.getVault()?.get("steve/users")).users;
    let currentModel: string | null = inferConfiguredModel(savedConfig);
    let modelProviders: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }> = [];

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

    return {
      ocStatus,
      agentEnabled,
      ocUrl,
      currentModel,
      modelProviders,
      attachedBrowser: readAttachedBrowserConfig(name),
      remoteBrowserAvailable: getBrowserSettings().remoteEnabled,
      browserCompanion,
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
    syncUserAgentsRuntime(updatedUsers);
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

  app.post("/users/:name/browser/attach", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    const rawChannel = String(result.body.channel || "stable").trim();
    const channel = rawChannel === "beta" || rawChannel === "dev" || rawChannel === "canary" ? rawChannel : "stable";
    writeAttachedBrowserConfig(validatedName.value, { channel });
    return c.redirect(`/users/${validatedName.value}/browser`);
  });

  app.post("/users/:name/browser/detach", async (c) => {
    const result = await deps.requireAdminForm(c);
    if (result instanceof Response) return result;

    const validatedName = validateUserSlug(c.req.param("name"));
    if (!validatedName.ok) return c.redirect("/");
    clearAttachedBrowserConfig(validatedName.value);
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
      setupUserWorkspace(name);
      const nextState = upsertUserAgentRecord(readUserAgentState(), name, { enabled: true });
      writeUserAgentState(nextState);
      writeUserAgentsCompose(nextState);
      startUserAgent(deps.composeProject, name);
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
      const nextState = upsertUserAgentRecord(readUserAgentState(), validatedName.value, { enabled: false });
      writeUserAgentState(nextState);
      writeUserAgentsCompose(nextState);
      removeUserAgent(deps.composeProject, validatedName.value);
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

    const providerId = String(result.body.provider_id || "").trim();
    const modelId = String(result.body.model_id || "").trim();
    if (!providerId || !modelId) {
      return c.redirect(`/users/${validatedName.value}/agent`);
    }

    const nextConfig = readUserOpenCodeConfig(validatedName.value);
    nextConfig.model = `${providerId}/${modelId}`;

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

    writeFileSync(getUserOpenCodeConfigPath(validatedName.value), `${JSON.stringify(nextConfig, null, 2)}\n`, "utf-8");
    const state = await getUserPageState(validatedName.value);
    if (state?.agentEnabled) {
      try {
        restartUserAgent(getComposeProject(), validatedName.value);
      } catch {
        startUserAgent(getComposeProject(), validatedName.value);
      }
    }
    return c.redirect(`/users/${validatedName.value}/agent`);
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
