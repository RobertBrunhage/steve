import type { ActivityEntry } from "../../activity.js";
import type { AttachedBrowserConfig } from "../../browser/types.js";
import type { BrowserCompanionStatus } from "../../browser/companion-status.js";
import type { UserAppSecretSummary } from "../../secrets.js";
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
  modelProviders?: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>;
  attachedBrowser?: AttachedBrowserConfig | null;
  remoteBrowserAvailable?: boolean;
  browserCompanion?: BrowserCompanionStatus;
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
  const statusTone = isRunning ? "text-emerald-400" : agentEnabled ? "text-amber-300" : "text-zinc-500";

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
      <a href="/" class="text-sm text-zinc-500 hover:text-zinc-300 transition-colors">&larr; Members</a>
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between mt-4 mb-6 gap-3 sm:gap-4">
        <div class="flex items-center gap-3 min-w-0">
          ${StatusDot({ state: dotState })}
          <h1 class="text-xl font-semibold text-white capitalize truncate">${escapeHtml(name)}</h1>
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
          <label class="block text-xs text-zinc-400 mb-1">Telegram chat ID</label>
          <input type="text" name="telegram_id" placeholder="e.g. 123456789" value="${escapeHtml(options?.telegramChatId || "")}"
            class="${inputClass}">
        </div>
        ${Button({ variant: "secondary", children: telegramConnected ? "Update" : "Connect" })}
      </form>
      <p class="text-xs text-zinc-600 mt-3">Open Telegram, message <strong class="text-zinc-400">@userinfobot</strong>, and it will reply with your chat ID. Paste it above.</p>
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
    <p class="text-xs text-zinc-600 mt-3">${canAttach ? "Once attached, tell Kellix to use your attached browser only for sites that need it." : "Start the companion first, then attach Chrome for this member."}</p>
  `;

  const attachedDetail = attachedBrowser ? `
    <div class="flex items-center justify-between gap-4 text-xs text-zinc-500 mt-4 pt-4 border-t border-border">
      <div class="space-y-1">
        <div>Channel: <span class="text-zinc-300">${escapeHtml(attachedBrowser.channel)}</span></div>
        <div>Last connected: <span class="text-zinc-300">${escapeHtml(formatDateTime(attachedBrowser.lastConnectedAt || undefined))}</span></div>
      </div>
      <form method="POST" action="/users/${slug}/browser/detach" class="inline">
        ${hiddenCsrf(csrfToken)}
        ${Button({ variant: "danger", size: "sm", children: "Detach" })}
      </form>
    </div>
    ${attachedBrowser.lastError ? `<p class="text-xs text-red-300 mt-3">${escapeHtml(attachedBrowser.lastError)}</p>` : ""}
  ` : "";

  const explainer = `
    <div class="rounded-lg border border-sky-900/60 bg-sky-950/20 p-4 mb-4">
      <p class="text-xs text-sky-100">Use attached Chrome only when a site needs manual sign-in, passkeys, or a more real browser. Most browsing should stay in the container browser.</p>
    </div>
  `;

  const companionPanel = `
    <div class="rounded-lg border border-border bg-surface p-4 mb-4">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3">
        <div class="min-w-0">
          <p class="text-xs font-medium text-zinc-300">Remote browser companion</p>
          <p class="text-xs text-zinc-500 mt-1">${escapeHtml(browserCompanion.message)}</p>
        </div>
        ${Badge({ tone: companionTone, children: companionLabel })}
      </div>
      <p class="text-xs text-zinc-500">Start it manually with <code class="text-zinc-300">kellix browser up</code>. Kellix will not auto-start it for you.</p>
    </div>
  `;

  const setupSteps = `
    <div class="rounded-lg border border-border bg-surface p-4 mb-4">
      <p class="text-xs font-medium text-zinc-300 mb-3">Setup steps</p>
      <ol class="space-y-2 text-xs text-zinc-500 list-decimal pl-4">
        <li>${browserCompanion.running ? "Keep the remote browser companion running on the Kellix machine." : "On the Kellix machine, run <code class=\"text-zinc-300\">kellix browser up</code>."}</li>
        <li>Open Chrome on that same machine.</li>
        <li>Enable remote debugging at <a href="chrome://inspect/#remote-debugging" class="text-zinc-300 underline decoration-zinc-600 underline-offset-2 hover:text-white">chrome://inspect/#remote-debugging</a>.</li>
        <li>Choose the Chrome channel below and click <strong class="text-zinc-300">Attach Local Chrome</strong>.</li>
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
    <div class="bg-surface border border-border rounded-lg p-4 hover:border-zinc-600 transition-colors">
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0">
          <h3 class="text-sm font-medium text-white">${escapeHtml(title)}</h3>
          <p class="text-xs text-zinc-500 mt-1 truncate">${escapeHtml(secret.fields.join(", "))}</p>
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

export function renderUserAgentPage(name: string, ocStatus: string, ocUrl: string, csrfToken: string, options?: RenderUserOptions): string {
  const slug = encodeURIComponent(name);
  const providers = options?.modelProviders || [];
  const currentModel = options?.currentModel || "";
  const [currentProvider, currentModelId] = currentModel.includes("/")
    ? [currentModel.split("/")[0] || "", currentModel.slice(currentModel.indexOf("/") + 1)]
    : ["", currentModel];

  const currentModelPill = currentModel ? `
    <div class="flex items-center gap-3 mb-4 px-3 py-2.5 bg-surface rounded-lg border border-border">
      ${StatusDot({ state: "ok" })}
      <span class="text-sm text-zinc-200 font-mono break-all">${escapeHtml(currentModel)}</span>
    </div>
  ` : "";

  // Alpine state for the dependent provider/model dropdown. Both selects are
  // x-model bound; switching providers re-renders the model options via x-for
  // and snaps to the first model if the previous selection isn't valid.
  const pickerState = jsonAttr({
    providers,
    providerId: currentProvider || providers[0]?.id || "",
    modelId: currentModelId || "",
  });

  const modelForm = providers.length > 0 ? `
    ${!currentModel ? `<p class="text-xs text-zinc-500 mb-3">Pick a provider and model below, then save to get started.</p>` : ""}
    <form method="POST" action="/users/${slug}/agent/model"
      x-data='${pickerState}'
      x-effect="
        const cm = (providers.find((p) => p.id === providerId) || { models: [] }).models;
        if (cm.length > 0 && !cm.some((m) => m.id === modelId)) modelId = cm[0].id;
      "
      class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-3 items-end">
      ${hiddenCsrf(csrfToken)}
      <div>
        <label for="provider_id" class="block text-xs text-zinc-400 mb-1">Provider</label>
        <select id="provider_id" name="provider_id" x-model="providerId" class="${inputClass}">
          <template x-for="p in providers" :key="p.id">
            <option :value="p.id" x-text="p.name"></option>
          </template>
        </select>
      </div>
      <div>
        <label for="model_id" class="block text-xs text-zinc-400 mb-1">Model</label>
        <select id="model_id" name="model_id" x-model="modelId" class="${inputClass}">
          <template x-for="m in (providers.find((p) => p.id === providerId) || { models: [] }).models" :key="m.id">
            <option :value="m.id" x-text="m.name"></option>
          </template>
        </select>
      </div>
      ${Button({ variant: "primary", children: "Save" })}
    </form>
    <p class="text-xs text-zinc-600 mt-3">${currentModel ? "The agent restarts automatically after saving so changes take effect right away." : "Kellix will restart the agent after saving."}</p>
  ` : `
    <p class="text-xs text-zinc-500">No models available yet. Start the agent first — providers and models will appear once the runtime is ready.</p>
  `;

  const modelSection = Section({
    title: "AI model",
    description: "The model Kellix uses when responding to Telegram messages and running background tasks for this member.",
    className: "mb-6",
    children: `
      ${currentModelPill}
      ${modelForm}
    `,
  });

  const sessionsSection = ocUrl ? `
    <div class="bg-surface-card border border-border rounded-lg overflow-hidden mb-6">
      <div class="flex items-center justify-between px-5 py-3 border-b border-border">
        <h2 class="text-sm font-medium text-white">Sessions</h2>
        <a href="${ocUrl}/L2RhdGE" target="_blank"
          class="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">Open in new tab &nearr;</a>
      </div>
      <p class="text-xs text-zinc-600 px-5 py-2">Live view of the agent's coding environment. Click the project name (top-left) and search <code class="text-zinc-300">//data</code> to browse past sessions.</p>
      <iframe src="${ocUrl}" class="w-full border-0" style="height:600px"></iframe>
    </div>
  ` : Section({
    title: "Sessions",
    className: "mb-6",
    children: `<p class="text-sm text-zinc-500">Start the agent to view live sessions here.</p>`,
  });

  const logsSection = Section({
    title: "Logs",
    description: "Recent output from this member's agent. Updates every few seconds.",
    children: `
      <pre id="logs"
           class="bg-black/50 rounded-lg p-4 text-xs text-zinc-400 font-mono overflow-auto max-h-60 whitespace-pre-wrap"
           hx-get="/users/${slug}/logs"
           hx-trigger="load, every 5s"
           hx-swap="innerHTML"
           hx-on::after-settle="this.scrollTop = this.scrollHeight">Loading…</pre>
    `,
  });

  return renderUserFrame(name, ocStatus, csrfToken, "agent", `
    ${modelSection}
    ${sessionsSection}
    ${logsSection}
  `, options);
}
