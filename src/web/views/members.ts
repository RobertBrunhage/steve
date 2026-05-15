import type { ActivityEntry } from "../../activity.js";
import type { AttachedBrowserConfig } from "../../browser/types.js";
import type { BrowserCompanionStatus } from "../../browser/companion-status.js";
import type { UserAppSecretSummary } from "../../secrets.js";
import type { KellixUserAgent } from "../../user-agents.js";
import {
  Badge,
  Button,
  EmptyState,
  Section,
  Select,
  StatusDot,
  Tabs,
  escapeHtml,
  hiddenCsrf,
  inputClass,
  jsonAttr,
  type DotState,
  type TabIndicator,
  type Tone,
} from "../components.js";
import { formatDateTime, layout, nav, renderActivityItems, titleCase } from "./layout.js";

export type UserPageTab = "connections" | "integrations" | "browser" | "agent";

export interface RenderUserOptions {
  agentEnabled?: boolean;
  telegramChatId?: string | null;
  userSecrets?: UserAppSecretSummary[];
  recentActivity?: ActivityEntry[];
  currentModel?: string | null;
  thinkingLevel?: string;
  modelProviders?: Array<{ id: string; name: string; models: Array<{ id: string; name: string; variants?: string[] }> }>;
  opencodeImage?: string;
  attachedBrowser?: AttachedBrowserConfig | null;
  remoteBrowserAvailable?: boolean;
  browserCompanion?: BrowserCompanionStatus;
  kellixAgents?: KellixUserAgent[];
  defaultAgentId?: string;
}

type ModelOption = { id: string; name: string; variants?: string[] };
type ModelProvider = { id: string; name: string; models: ModelOption[] };

function toQualifiedModelId(providerId: string, modelId: string): string {
  return modelId.includes("/") ? modelId : `${providerId}/${modelId}`;
}

function ensureCurrentModelIsSelectable(providers: ModelProvider[], currentModel: string): ModelProvider[] {
  if (!currentModel.includes("/")) return providers;

  const providerId = currentModel.split("/")[0] || "";
  if (!providerId) return providers;

  const providerIndex = providers.findIndex((provider) => provider.id === providerId);
  if (providerIndex === -1) {
    const modelName = currentModel.slice(currentModel.indexOf("/") + 1) || currentModel;
    return [...providers, { id: providerId, name: providerId, models: [{ id: currentModel, name: modelName, variants: [] }] }];
  }

  const provider = providers[providerIndex]!;
  if (provider.models.some((model) => model.id === currentModel)) return providers;

  const modelName = currentModel.slice(currentModel.indexOf("/") + 1) || currentModel;

  const nextModels = [...provider.models, { id: currentModel, name: modelName }]
    .sort((a, b) => a.name.localeCompare(b.name));

  return providers.map((entry, index) => index === providerIndex ? { ...entry, models: nextModels } : entry);
}

function userTabsList(name: string, options?: RenderUserOptions, ocStatus?: string): Array<{ key: UserPageTab; label: string; href: string; indicator?: TabIndicator }> {
  const slug = encodeURIComponent(name);
  const telegramConnected = !!options?.telegramChatId;
  const integrationCount = options?.userSecrets?.length ?? 0;
  const browserAttached = !!options?.attachedBrowser;
  const agentEnabled = !!options?.agentEnabled;
  const agentDot: DotState = ocStatus === "running" ? "ok" : agentEnabled ? "warn" : "off";

  return [
    {
      key: "connections",
      label: "Connections",
      href: `/users/${slug}`,
      indicator: { kind: "dot", state: telegramConnected ? "ok" : "off" },
    },
    {
      key: "integrations",
      label: "Integrations",
      href: `/users/${slug}/integrations`,
      indicator: { kind: "count", value: integrationCount },
    },
    {
      key: "browser",
      label: "Browser",
      href: `/users/${slug}/browser`,
      indicator: { kind: "dot", state: browserAttached ? "ok" : "off" },
    },
    {
      key: "agent",
      label: "Agent",
      href: `/users/${slug}/agent`,
      indicator: { kind: "dot", state: agentDot },
    },
  ];
}

function renderUserTabs(name: string, active: UserPageTab, options?: RenderUserOptions, ocStatus?: string): string {
  return Tabs({ items: userTabsList(name, options, ocStatus), active, swapTarget: "#tab-body" });
}

// Exported so route handlers can return just the header HTML as an htmx
// fragment after start/stop/restart, swapping it in place without a full
// page reload.
export function renderUserHeader(name: string, ocStatus: string, agentEnabled: boolean, csrfToken: string): string {
  const slug = encodeURIComponent(name);
  const isRunning = ocStatus === "running";
  const dotState: "ok" | "warn" | "off" = isRunning ? "ok" : agentEnabled ? "warn" : "off";
  const statusLabel = isRunning ? "Running" : agentEnabled ? "Unavailable" : "Paused";
  const statusTone = isRunning ? "text-emerald-600" : agentEnabled ? "text-amber-600" : "text-neutral-400";

  // Every action button targets the header itself so htmx swaps it in place.
  // The route handler returns just renderUserHeader() when HX-Request is set.
  const swapAttrs = `hx-target="#user-header" hx-swap="outerHTML" hx-disabled-elt="find button"`;

  const actions = agentEnabled
    ? `
      <form method="POST" action="/users/${slug}/stop" class="inline" ${swapAttrs}>
        ${hiddenCsrf(csrfToken)}
        ${Button({ variant: "danger", size: "sm", children: "Stop" })}
      </form>
      <form method="POST" action="/users/${slug}/${isRunning ? "restart" : "start"}" class="inline" ${swapAttrs}>
        ${hiddenCsrf(csrfToken)}
        ${Button({ variant: "secondary", size: "sm", children: isRunning ? "Restart" : "Start" })}
      </form>
    `
    : `
      <form method="POST" action="/users/${slug}/start" class="inline" ${swapAttrs}>
        ${hiddenCsrf(csrfToken)}
        ${Button({ variant: "primary", size: "md", children: "Start Agent" })}
      </form>
    `;

  return `
    <div id="user-header">
      <a href="/" class="text-sm text-neutral-400 hover:text-neutral-600 transition-colors">&larr; Members</a>
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between mt-4 mb-6 gap-3 sm:gap-4">
        <div class="flex items-center gap-3 min-w-0">
          ${StatusDot({ state: dotState })}
          <h1 class="text-xl font-display font-bold text-neutral-900 capitalize truncate">${escapeHtml(name)}</h1>
          <span class="text-xs ${statusTone}">${statusLabel}</span>
        </div>
        <div class="flex gap-2 flex-shrink-0">
          ${actions}
        </div>
      </div>
    </div>`;
}

function renderUserFrame(name: string, ocStatus: string, csrfToken: string, activeTab: UserPageTab, body: string, options?: RenderUserOptions): string {
  // The tabs nav AND the tab body live inside #tab-body so a tab click can
  // swap both at once (active state + content + tab status indicators) via
  // htmx hx-select.
  return layout(`${name}`, `
    ${nav(csrfToken, "home")}
    ${renderUserHeader(name, ocStatus, options?.agentEnabled ?? false, csrfToken)}
    <div id="tab-body">
      ${renderUserTabs(name, activeTab, options, ocStatus)}
      ${body}
    </div>
  `, { width: "app" });
}

export function renderUserConnections(name: string, ocStatus: string, csrfToken: string, options?: RenderUserOptions): string {
  const telegramConnected = !!options?.telegramChatId;
  const slug = encodeURIComponent(name);
  const telegramBadge = Badge({
    tone: telegramConnected ? "ok" : "neutral",
    children: telegramConnected ? "Connected" : "Not connected",
  });

  const telegramSection = Section({
    title: "Telegram",
    description: "Link Telegram so Kellix can message this user directly.",
    badge: telegramBadge,
    className: "mb-6",
    children: `
      <form method="POST" action="/users/${slug}/telegram" class="flex flex-col sm:flex-row gap-3 sm:items-end">
        ${hiddenCsrf(csrfToken)}
        <div class="flex-1">
          <label class="block text-xs text-neutral-500 mb-1">Telegram chat ID</label>
          <input type="text" name="telegram_id" placeholder="e.g. 123456789" value="${escapeHtml(options?.telegramChatId || "")}"
            class="${inputClass}">
        </div>
        ${Button({ variant: "secondary", children: telegramConnected ? "Update" : "Connect" })}
      </form>
      <p class="text-xs text-neutral-400 mt-3">Open Telegram, message <strong class="text-neutral-500">@userinfobot</strong>, and it will reply with your chat ID. Paste it above.</p>
    `,
  });

  const activitySection = Section({
    title: "Recent activity",
    description: "What Kellix has been doing for this member recently.",
    children: renderActivityItems(options?.recentActivity || []),
  });

  return renderUserFrame(name, ocStatus, csrfToken, "connections", `
    ${telegramSection}
    ${activitySection}
  `, options);
}

export function renderUserBrowserPage(name: string, ocStatus: string, csrfToken: string, options?: RenderUserOptions): string {
  const slug = encodeURIComponent(name);
  const attachedBrowser = options?.attachedBrowser || null;
  const browserCompanion = options?.browserCompanion || {
    available: false,
    running: false,
    message: "The remote browser companion is not configured for this install yet.",
  };
  const canAttach = browserCompanion.available && browserCompanion.running;

  const companionTone: Tone = !browserCompanion.available ? "neutral" : browserCompanion.running ? "ok" : "warn";
  const companionLabel = !browserCompanion.available ? "Not configured" : browserCompanion.running ? "Running" : "Stopped";

  const channels = [
    { value: "stable", label: "Stable" },
    { value: "beta", label: "Beta" },
    { value: "dev", label: "Dev" },
    { value: "canary", label: "Canary" },
  ].map((c) => ({ ...c, selected: attachedBrowser?.channel === c.value || (!attachedBrowser && c.value === "stable") }));

  const attachForm = `
    <form method="POST" action="/users/${slug}/browser/attach" class="flex flex-col sm:flex-row gap-3 items-stretch sm:items-end">
      ${hiddenCsrf(csrfToken)}
      <div class="flex-1">
        ${Select({ name: "channel", label: "Chrome channel", options: channels })}
      </div>
      ${Button({ variant: "secondary", disabled: !canAttach, children: attachedBrowser ? "Update Attach" : "Attach Local Chrome" })}
    </form>
    <p class="text-xs text-neutral-400 mt-3">${canAttach ? "Once attached, tell Kellix to use your attached browser only for sites that need it." : "Start the companion first, then attach Chrome for this member."}</p>
  `;

  const attachedDetail = attachedBrowser ? `
    <div class="flex items-center justify-between gap-4 text-xs text-neutral-400 mt-4 pt-4 border-t border-border">
      <div class="space-y-1">
        <div>Channel: <span class="text-neutral-600">${escapeHtml(attachedBrowser.channel)}</span></div>
        <div>Last connected: <span class="text-neutral-600">${escapeHtml(formatDateTime(attachedBrowser.lastConnectedAt || undefined))}</span></div>
      </div>
      <form method="POST" action="/users/${slug}/browser/detach" class="inline">
        ${hiddenCsrf(csrfToken)}
        ${Button({ variant: "danger", size: "sm", children: "Detach" })}
      </form>
    </div>
    ${attachedBrowser.lastError ? `<p class="text-xs text-red-600 mt-3">${escapeHtml(attachedBrowser.lastError)}</p>` : ""}
  ` : "";

  const explainer = `
    <div class="rounded-lg border border-sky-200 bg-sky-50 p-4 mb-4">
      <p class="text-xs text-sky-800">Use attached Chrome only when a site needs manual sign-in, passkeys, or a more real browser. Most browsing should stay in the container browser.</p>
    </div>
  `;

  const companionPanel = `
    <div class="rounded-lg border border-border bg-surface p-4 mb-4">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3">
        <div class="min-w-0">
          <p class="text-xs font-medium text-neutral-600">Remote browser companion</p>
          <p class="text-xs text-neutral-400 mt-1">${escapeHtml(browserCompanion.message)}</p>
        </div>
        ${Badge({ tone: companionTone, children: companionLabel })}
      </div>
      <p class="text-xs text-neutral-400">Start it manually with <code class="text-neutral-600">kellix browser up</code>. Kellix will not auto-start it for you.</p>
    </div>
  `;

  const setupSteps = `
    <div class="rounded-lg border border-border bg-surface p-4 mb-4">
      <p class="text-xs font-medium text-neutral-600 mb-3">Setup steps</p>
      <ol class="space-y-2 text-xs text-neutral-400 list-decimal pl-4">
        <li>${browserCompanion.running ? "Keep the remote browser companion running on the Kellix machine." : "On the Kellix machine, run <code class=\"text-neutral-600\">kellix browser up</code>."}</li>
        <li>Open Chrome on that same machine.</li>
        <li>Enable remote debugging at <a href="chrome://inspect/#remote-debugging" class="text-neutral-600 underline decoration-neutral-300 underline-offset-2 hover:text-neutral-900">chrome://inspect/#remote-debugging</a>.</li>
        <li>Choose the Chrome channel below and click <strong class="text-neutral-600">Attach Local Chrome</strong>.</li>
        <li>When Kellix needs the attached browser, approve the prompt in Chrome.</li>
      </ol>
    </div>
  `;

  const browserSection = Section({
    title: "Attached browser",
    description: "Only for sites that need a real signed-in Chrome session.",
    badge: Badge({
      tone: attachedBrowser ? "ok" : "neutral",
      children: attachedBrowser ? "Attached" : "Not attached",
    }),
    children: `
      ${explainer}
      ${companionPanel}
      ${setupSteps}
      ${attachForm}
      ${attachedDetail}
    `,
  });

  return renderUserFrame(name, ocStatus, csrfToken, "browser", browserSection, options);
}

function renderIntegrationRow(name: string, secret: UserAppSecretSummary, csrfToken: string): string {
  const slug = encodeURIComponent(name);
  const integrationSlug = encodeURIComponent(secret.integration);
  const title = titleCase(secret.integration);
  return `
    <div class="bg-surface border border-border rounded-lg p-4 hover:border-neutral-400 transition-colors">
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0">
          <h3 class="text-sm font-medium text-neutral-900">${escapeHtml(title)}</h3>
          <p class="text-xs text-neutral-400 mt-1 truncate">${escapeHtml(secret.fields.join(", "))}</p>
        </div>
        <div class="flex gap-2 flex-shrink-0">
          ${Button({ variant: "secondary", size: "sm", href: `/users/${slug}/integrations/${integrationSlug}/edit`, children: "Edit" })}
          <form method="POST" action="/users/${slug}/integrations/${integrationSlug}/delete" class="inline" onsubmit="return confirm('Delete ${escapeHtml(title)}?')">
            ${hiddenCsrf(csrfToken)}
            ${Button({ variant: "danger", size: "sm", children: "Delete" })}
          </form>
        </div>
      </div>
    </div>`;
}

export function renderUserIntegrationsPage(name: string, ocStatus: string, csrfToken: string, options?: RenderUserOptions): string {
  const slug = encodeURIComponent(name);
  const secrets = options?.userSecrets || [];

  const addButton = Button({ variant: "primary", href: `/users/${slug}/integrations/new`, children: "Add integration" });

  const body = secrets.length === 0
    ? EmptyState({
        title: "No integrations yet",
        description: "Connect a third-party service so Kellix can fetch data or take actions on your behalf.",
        action: addButton,
      })
    : `<div class="space-y-3">${secrets.map((s) => renderIntegrationRow(name, s, csrfToken)).join("")}</div>`;

  const section = Section({
    title: "Integrations",
    description: "API keys and credentials Kellix uses to connect to third-party services for this member.",
    actions: secrets.length > 0 ? addButton : "",
    children: body,
  });

  return renderUserFrame(name, ocStatus, csrfToken, "integrations", section, options);
}

export function renderUserAgentPage(name: string, ocStatus: string, _ocUrl: string, csrfToken: string, options?: RenderUserOptions): string {
  const slug = encodeURIComponent(name);
  const agents = options?.kellixAgents || [];
  const defaultAgentId = options?.defaultAgentId || "kellix";
  const agentsSection = Section({
    title: "Kellix agents",
    description: "Each agent has its own workspace, sessions, and Telegram routing. Open an agent to configure its profile, model, runtime, and skills.",
    className: "mb-6",
    children: `
      <div class="space-y-3 mb-6">
        ${agents.map((agent) => `
          <a href="/users/${slug}/agents/${encodeURIComponent(agent.id)}" class="block border border-border rounded-xl p-4 sm:p-5 hover:border-neutral-400 transition-colors">
            <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div class="min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="text-base font-medium text-neutral-900">${escapeHtml(agent.name)}</span>
                  <code class="text-xs text-neutral-400 break-all">${escapeHtml(agent.id)}</code>
                  ${agent.id === defaultAgentId ? Badge({ tone: "ok", children: "Default" }) : ""}
                  ${agent.setupStatus === "needs_setup" ? Badge({ tone: "warn", children: "Needs setup" }) : ""}
                </div>
                <p class="text-xs text-neutral-400 mt-2 max-w-3xl whitespace-pre-wrap break-words">${escapeHtml(agent.roleSummary || agent.goal || "This agent will ask what it should do the first time you message it.")}</p>
                <p class="text-xs text-neutral-400 mt-2">Telegram: ${agent.channels?.telegram?.chatId ? `chat ${escapeHtml(agent.channels.telegram.chatId)}` : "uses default chat unless an agent bot is configured"}</p>
              </div>
              <div class="flex gap-2 sm:justify-end flex-wrap flex-shrink-0 items-center" onclick="event.stopPropagation()">
                ${agent.id !== defaultAgentId ? `
                <form method="POST" action="/users/${slug}/agents/${encodeURIComponent(agent.id)}/default">
                  ${hiddenCsrf(csrfToken)}
                  ${Button({ variant: "secondary", size: "sm", children: "Set default" })}
                </form>
                ` : ""}
                ${agent.id !== "kellix" ? `
                <form method="POST" action="/users/${slug}/agents/${encodeURIComponent(agent.id)}/delete" onsubmit="return confirm('Delete ${escapeHtml(agent.name)}?')">
                  ${hiddenCsrf(csrfToken)}
                  ${Button({ variant: "danger", size: "sm", children: "Delete" })}
                </form>
                ` : ""}
                <span class="text-xs text-neutral-400">Open &rarr;</span>
              </div>
            </div>
          </a>
        `).join("")}
      </div>
      <form method="POST" action="/users/${slug}/agents" class="border border-dashed border-neutral-200 rounded-xl p-4 sm:p-5">
        ${hiddenCsrf(csrfToken)}
        <div class="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4 mb-4">
          <div>
            <h3 class="text-sm font-medium text-neutral-900">Create specialist agent</h3>
            <p class="text-xs text-neutral-400 mt-1">Give it a stable ID and name. The agent will ask what it is for when you first message it.</p>
          </div>
          ${Button({ variant: "primary", children: "Create" })}
        </div>
        <div class="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 mb-3">
          <div>
            <label for="agent_id" class="block text-xs font-medium text-neutral-600 mb-1">ID</label>
            <input id="agent_id" name="id" class="${inputClass}" placeholder="sysadmin" required>
            <p class="text-xs text-neutral-400 mt-2">Lowercase handle used for routing and files.</p>
          </div>
          <div>
            <label for="agent_name" class="block text-xs font-medium text-neutral-600 mb-1">Name</label>
            <input id="agent_name" name="name" class="${inputClass}" placeholder="Sysadmin" required>
          </div>
        </div>
      </form>
    `,
  });

  return renderUserFrame(name, ocStatus, csrfToken, "agent", agentsSection, options);
}

// --- Per-agent detail page ------------------------------------------------

export interface RenderUserAgentDetailOptions {
  userName: string;
  agent: KellixUserAgent;
  defaultAgentId: string;
  csrfToken: string;
  runtime: {
    status: "running" | "stopped" | "paused" | "unknown";
    agentEnabled: boolean;
    ocUrl: string;
    currentModel: string | null;
    thinkingLevel: string;
    modelProviders: Array<{ id: string; name: string; models: Array<{ id: string; name: string; variants: string[] }> }>;
  };
  opencodeImage?: string;
}

export function renderUserAgentDetailPage(opts: RenderUserAgentDetailOptions): string {
  const { userName, agent, defaultAgentId, csrfToken, runtime, opencodeImage } = opts;
  const slug = encodeURIComponent(userName);
  const agentSlug = encodeURIComponent(agent.id);
  const isDefault = agent.id === defaultAgentId;
  const isKellix = agent.id === "kellix";
  const textareaClass = `${inputClass} min-h-24 resize-y leading-relaxed`;

  const statusDot: "ok" | "warn" | "off" = runtime.status === "running" ? "ok" : runtime.agentEnabled ? "warn" : "off";
  const statusLabel = runtime.status === "running" ? "Running" : runtime.agentEnabled ? "Stopped" : "Paused";

  const currentModel = runtime.currentModel || "";
  const providers = ensureCurrentModelIsSelectable(
    runtime.modelProviders.map((provider) => ({
      ...provider,
      models: provider.models.map((model) => ({
        ...model,
        id: toQualifiedModelId(provider.id, model.id),
      })),
    })),
    currentModel,
  );
  const [currentProvider, configuredModelId] = currentModel.includes("/")
    ? [currentModel.split("/")[0] || "", currentModel]
    : ["", currentModel];
  const initialProviderId = currentProvider || providers[0]?.id || "";
  const initialProviderModels = providers.find((provider) => provider.id === initialProviderId)?.models || [];
  const initialModelId = initialProviderModels.some((model) => model.id === configuredModelId)
    ? configuredModelId
    : "";

  const pickerState = jsonAttr({
    providers,
    providerId: initialProviderId,
    modelId: "",
    initialModelId,
  });

  const runtimeControls = `
    <div class="flex flex-wrap gap-2">
      ${runtime.agentEnabled
        ? `
          <form method="POST" action="/users/${slug}/agents/${agentSlug}/stop" class="inline">
            ${hiddenCsrf(csrfToken)}
            ${Button({ variant: "danger", size: "sm", children: "Stop" })}
          </form>
          <form method="POST" action="/users/${slug}/agents/${agentSlug}/${runtime.status === "running" ? "restart" : "start"}" class="inline">
            ${hiddenCsrf(csrfToken)}
            ${Button({ variant: "secondary", size: "sm", children: runtime.status === "running" ? "Restart" : "Start" })}
          </form>
        `
        : `
          <form method="POST" action="/users/${slug}/agents/${agentSlug}/start" class="inline">
            ${hiddenCsrf(csrfToken)}
            ${Button({ variant: "primary", size: "sm", children: "Start agent" })}
          </form>
        `}
    </div>
  `;

  const profileSection = Section({
    title: "Profile",
    description: "Durable role + instructions for this agent. Stored in this agent's AGENTS.md.",
    className: "mb-6",
    children: `
      ${agent.setupStatus === "needs_setup" ? Badge({ tone: "warn", children: "Needs setup", className: "mb-4" }) : ""}
      <form method="POST" action="/users/${slug}/agents/${agentSlug}" class="space-y-3">
        ${hiddenCsrf(csrfToken)}
        <div>
          <label class="block text-xs font-medium text-neutral-600 mb-1">Display name</label>
          <input type="text" name="name" class="${inputClass}" value="${escapeHtml(agent.name)}" required>
        </div>
        <div>
          <label class="block text-xs font-medium text-neutral-600 mb-1">Role summary</label>
          <input type="text" name="roleSummary" class="${inputClass}" value="${escapeHtml(agent.roleSummary || agent.goal || "")}" placeholder="Short summary shown in the dashboard">
        </div>
        <div>
          <label class="block text-xs font-medium text-neutral-600 mb-1">Agent instructions</label>
          <textarea name="instructions" class="${textareaClass}" placeholder="Usually filled in by the agent after first-use setup.">${escapeHtml(agent.instructions || "")}</textarea>
          <p class="text-xs text-neutral-400 mt-2">Stored in <code>agents/${escapeHtml(agent.id)}/AGENTS.md</code>. Leave blank to let the agent configure itself.</p>
        </div>
        <div class="flex justify-end gap-2 flex-wrap">
          ${!isKellix ? `
          <button type="submit" form="reset-${escapeHtml(agent.id)}" class="inline-flex items-center justify-center gap-2 font-medium rounded-lg transition-colors whitespace-nowrap focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-white focus:ring-emerald-500/40 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1.5 text-xs bg-transparent text-neutral-500 hover:text-neutral-900 hover:bg-neutral-100">Reset setup</button>
          ` : ""}
          ${Button({ variant: "secondary", size: "sm", children: "Save profile" })}
        </div>
      </form>
      ${!isKellix ? `
      <form id="reset-${escapeHtml(agent.id)}" method="POST" action="/users/${slug}/agents/${agentSlug}/reset-setup">
        ${hiddenCsrf(csrfToken)}
      </form>
      ` : ""}
    `,
  });

  const telegramSection = Section({
    title: "Telegram",
    description: "Optional dedicated Telegram bot/chat for this agent. Leave blank to share the member's main Telegram.",
    className: "mb-6",
    children: `
      <form method="POST" action="/users/${slug}/agents/${agentSlug}/telegram" class="space-y-3">
        ${hiddenCsrf(csrfToken)}
        <div>
          <label class="block text-xs font-medium text-neutral-600 mb-1">Agent bot token</label>
          <input type="password" name="bot_token" class="${inputClass}" placeholder="Blank keeps current token">
        </div>
        <div>
          <label class="block text-xs font-medium text-neutral-600 mb-1">Telegram chat ID</label>
          <input type="text" name="chat_id" class="${inputClass}" value="${escapeHtml(agent.channels?.telegram?.chatId || "")}" placeholder="Uses member chat when blank">
        </div>
        <div class="flex justify-end">
          ${Button({ variant: "secondary", size: "sm", children: "Save Telegram" })}
        </div>
      </form>
    `,
  });

  const modelForm = providers.length > 0 ? `
    <form method="POST" action="/users/${slug}/agents/${agentSlug}/model"
      x-data='${pickerState}'
      x-init="$nextTick(() => {
        const cm = (providers.find((p) => p.id === providerId) || { models: [] }).models;
        modelId = initialModelId && cm.some((m) => m.id === initialModelId)
          ? initialModelId
          : (cm[0]?.id || '');
      })"
      x-effect="
        const cm = (providers.find((p) => p.id === providerId) || { models: [] }).models;
        if (cm.length === 0) modelId = '';
        else if (!cm.some((m) => m.id === modelId)) modelId = cm[0].id;
      "
      class="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,220px)_auto] gap-3 items-end">
      ${hiddenCsrf(csrfToken)}
      <div>
        <label class="block text-xs text-neutral-500 mb-1">Provider</label>
        <select name="provider_id" x-model="providerId" class="${inputClass}">
          <template x-for="p in providers" :key="p.id">
            <option :value="p.id" x-text="p.name"></option>
          </template>
        </select>
      </div>
      <div>
        <label class="block text-xs text-neutral-500 mb-1">Model</label>
        <select name="model_id" x-model="modelId" class="${inputClass}">
          <template x-for="m in (providers.find((p) => p.id === providerId) || { models: [] }).models" :key="m.id">
            <option :value="m.id" x-text="m.name"></option>
          </template>
        </select>
      </div>
      <div x-show="(((providers.find((p) => p.id === providerId) || { models: [] }).models.find((m) => m.id === modelId) || { variants: [] }).variants || []).length > 0" x-cloak>
        <label class="block text-xs font-medium text-neutral-600 mb-1">Thinking</label>
        <select name="thinking_level" class="${inputClass}">
          <option value="default"${(runtime.thinkingLevel || "default") === "default" ? " selected" : ""}>Default</option>
          <template x-for="variant in (((providers.find((p) => p.id === providerId) || { models: [] }).models.find((m) => m.id === modelId) || { variants: [] }).variants || [])" :key="variant">
            <option :value="variant" x-text="variant" :selected="variant === '${escapeHtml(runtime.thinkingLevel || "")}'"></option>
          </template>
        </select>
      </div>
      ${Button({ variant: "primary", children: "Save" })}
    </form>
  ` : `<p class="text-xs text-neutral-400">No models available. Start the agent first.</p>`;

  const modelSection = Section({
    title: "AI model",
    description: "The model this agent uses when responding.",
    className: "mb-6",
    children: `
      ${currentModel ? `
        <div class="flex items-center gap-3 mb-4 px-3 py-2.5 bg-surface rounded-lg border border-border">
          ${StatusDot({ state: "ok" })}
          <span class="text-sm text-neutral-700 font-mono break-all">${escapeHtml(currentModel)}</span>
        </div>
      ` : ""}
      ${modelForm}
    `,
  });

  const sessionsBlock = runtime.ocUrl ? `
    <div class="bg-white border border-border rounded-lg overflow-hidden mb-6">
      <div class="flex items-center justify-between px-5 py-3 border-b border-border">
        <h2 class="text-sm font-medium text-neutral-900">Sessions</h2>
        <a href="${runtime.ocUrl}" target="_blank" class="text-xs text-neutral-400 hover:text-neutral-600 transition-colors">Open in new tab &nearr;</a>
      </div>
      <iframe src="${runtime.ocUrl}" class="w-full border-0" style="height:600px"></iframe>
    </div>
  ` : Section({
    title: "Sessions",
    className: "mb-6",
    children: `<p class="text-sm text-neutral-400">Start the agent to view live sessions here.</p>`,
  });

  const logsSection = Section({
    title: "Logs",
    description: "Recent output from this agent. Updates every few seconds.",
    children: `
      <pre id="logs"
           class="bg-neutral-100 rounded-lg p-4 text-xs text-neutral-500 font-mono overflow-auto max-h-60 whitespace-pre-wrap"
           hx-get="/users/${slug}/agents/${agentSlug}/logs"
           hx-trigger="load, every 5s"
           hx-swap="innerHTML"
           hx-on::after-settle="this.scrollTop = this.scrollHeight">Loading…</pre>
    `,
  });

  const runtimeSection = Section({
    title: "Runtime",
    description: `Container: opencode-${escapeHtml(userName)}-${escapeHtml(agent.id)}. Workspace: <code>users/${escapeHtml(userName)}/agents/${escapeHtml(agent.id)}</code>.`,
    className: "mb-6",
    children: `
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div class="flex items-center gap-2 text-sm">
          ${StatusDot({ state: statusDot })}
          <span class="text-neutral-700">${statusLabel}</span>
          ${opencodeImage ? `<span class="text-xs text-neutral-400 truncate">${escapeHtml(opencodeImage)}</span>` : ""}
        </div>
        ${runtimeControls}
      </div>
      <form method="POST" action="/users/${slug}/agents/${agentSlug}/update-opencode" class="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between pt-3 border-t border-border">
        ${hiddenCsrf(csrfToken)}
        <p class="text-xs text-neutral-400">Pull the latest OpenCode image and recreate this agent's container.</p>
        ${Button({ variant: "secondary", size: "sm", children: "Update OpenCode" })}
      </form>
    `,
  });

  const header = `
    <a href="/users/${slug}/agent" class="text-sm text-neutral-400 hover:text-neutral-600 transition-colors">&larr; Agents</a>
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between mt-4 mb-6 gap-3">
      <div class="min-w-0">
        <div class="flex items-center gap-2 flex-wrap">
          <h1 class="text-xl font-display font-bold text-neutral-900 truncate">${escapeHtml(agent.name)}</h1>
          <code class="text-xs text-neutral-400">${escapeHtml(agent.id)}</code>
          ${isDefault ? Badge({ tone: "ok", children: "Default" }) : ""}
        </div>
        <p class="text-xs text-neutral-400 mt-2 max-w-2xl whitespace-pre-wrap">${escapeHtml(agent.roleSummary || agent.goal || "")}</p>
      </div>
      <div class="flex gap-2 flex-shrink-0 flex-wrap">
        ${!isDefault ? `
        <form method="POST" action="/users/${slug}/agents/${agentSlug}/default">
          ${hiddenCsrf(csrfToken)}
          ${Button({ variant: "secondary", size: "sm", children: "Set default" })}
        </form>
        ` : ""}
        ${!isKellix ? `
        <form method="POST" action="/users/${slug}/agents/${agentSlug}/delete" onsubmit="return confirm('Delete ${escapeHtml(agent.name)}?')">
          ${hiddenCsrf(csrfToken)}
          ${Button({ variant: "danger", size: "sm", children: "Delete" })}
        </form>
        ` : ""}
      </div>
    </div>
  `;

  return layout(`${userName} / ${agent.id}`, `
    ${nav(csrfToken, "home")}
    ${header}
    ${runtimeSection}
    ${profileSection}
    ${modelSection}
    ${telegramSection}
    ${sessionsBlock}
    ${logsSection}
  `, { width: "app" });
}
