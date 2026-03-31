import type { HealthStatus } from "../health.js";
import type { ActivityEntry } from "../activity.js";
import type { UserAppSecretSummary } from "../secrets.js";
import type { ScheduledEntry } from "../scheduler.js";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function hiddenCsrf(csrfToken: string): string {
  return `<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">`;
}

function nav(csrfToken: string): string {
  return `
  <nav class="flex items-center justify-between gap-4 mb-8 border-b border-border pb-4">
    <div class="flex gap-4">
      <a href="/" class="text-sm text-zinc-400 hover:text-white transition-colors">Dashboard</a>
      <a href="/jobs" class="text-sm text-zinc-400 hover:text-white transition-colors">Tasks</a>
      <a href="/settings" class="text-sm text-zinc-400 hover:text-white transition-colors">Settings</a>
    </div>
    <form method="POST" action="/logout" class="inline">
      ${hiddenCsrf(csrfToken)}
      <button type="submit" class="text-sm text-zinc-500 hover:text-white transition-colors">Log out</button>
    </form>
  </nav>`;
}

const layout = (title: string, body: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Steve - ${title}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            surface: { DEFAULT: '#111113', card: '#18181b', hover: '#1e1e22' },
            border: { DEFAULT: '#27272a', focus: '#3b82f6' },
          }
        }
      }
    }
  </script>
</head>
<body class="dark bg-surface text-zinc-300 min-h-screen">
  <div class="max-w-xl mx-auto px-4 py-8">
    ${body}
  </div>
</body>
</html>`;

function flash(message: string, type: "success" | "error" = "success"): string {
  const styles = type === "success"
    ? "bg-emerald-950/50 border-emerald-800 text-emerald-300"
    : "bg-red-950/50 border-red-800 text-red-300";
  return `<div class="border rounded-lg px-4 py-3 mb-6 text-sm ${styles}">${escapeHtml(message)}</div>`;
}

function fieldRows(fields: [string, string][], options?: { maskValues?: boolean }): string {
  const valuePlaceholder = options?.maskValues ? "Leave blank to keep current value" : "value";
  const valueAttribute = (value: string) => options?.maskValues ? "" : ` value="${escapeHtml(value)}"`;
  return fields.map(([name, value], i) => `
    <div class="flex gap-2 items-center mt-2 group">
      <input type="text" name="field_name_${i}" value="${escapeHtml(name)}" placeholder="field name"
        class="flex-none w-36 px-3 py-2 bg-surface border border-border rounded-lg text-sm text-white font-mono placeholder-zinc-600 focus:border-border-focus focus:outline-none">
      <input type="password" name="field_value_${i}"${valueAttribute(value)} placeholder="${valuePlaceholder}"
        class="flex-1 px-3 py-2 bg-surface border border-border rounded-lg text-sm text-white font-mono placeholder-zinc-600 focus:border-border-focus focus:outline-none">
      <button type="button" onclick="this.parentElement.remove()"
        class="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 transition-opacity px-1 text-lg">&times;</button>
    </div>`).join("");
}

function titleCase(value: string): string {
  return value
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function formatDateTime(value: string | null | undefined, timeZone?: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });
}

function renderActivityItems(items: ActivityEntry[]): string {
  if (items.length === 0) {
    return `<p class="text-sm text-zinc-500">Nothing yet. Activity will show up here once Steve starts handling messages or tasks.</p>`;
  }

  return items.map((item) => {
    const statusColor = item.status === "error"
      ? "bg-red-400"
      : item.status === "ok"
        ? "bg-emerald-400"
        : "bg-zinc-500";
    return `
      <div class="flex items-start gap-3 py-3 border-b border-border last:border-b-0">
        <span class="inline-block w-2 h-2 rounded-full ${statusColor} mt-1.5 flex-shrink-0"></span>
        <div class="min-w-0 flex-1">
          <p class="text-sm text-zinc-200">${escapeHtml(item.summary)}</p>
          <p class="text-xs text-zinc-600 mt-1">${escapeHtml(formatDateTime(item.timestamp))}</p>
        </div>
      </div>`;
  }).join("");
}

export function renderHome(health: HealthStatus, csrfToken: string): string {
  const dot = (status: string) => {
    const color = status === "ok" ? "bg-emerald-400" : status === "error" ? "bg-red-400" : "bg-zinc-500";
    return `<span class="inline-block w-2 h-2 rounded-full ${color}"></span>`;
  };

  const { components: c, uptime, healthy } = health;

  return layout("Dashboard", `
    ${nav(csrfToken)}
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-xl font-semibold text-white">Steve</h1>
        <p class="text-sm text-zinc-500 mt-1">Manage users, integrations, and scheduled tasks from one place.</p>
      </div>
      <span class="text-xs px-2.5 py-1 rounded-full ${healthy ? "bg-emerald-950 text-emerald-300 border border-emerald-800" : "bg-red-950 text-red-300 border border-red-800"}">
        ${healthy ? "Healthy" : "Degraded"}
      </span>
    </div>

    <div class="grid grid-cols-2 gap-3 mb-8">
      ${Object.entries(c.opencode).map(([name, oc]) => `
      <a href="/users/${encodeURIComponent(name)}" class="bg-surface-card border border-border rounded-lg p-4 hover:border-zinc-500 transition-colors block group">
        <div class="flex items-center justify-between mb-2">
          <span class="text-base font-medium text-white capitalize">${escapeHtml(name)}</span>
          <span class="text-zinc-600 group-hover:text-zinc-400 transition-colors">&rarr;</span>
        </div>
        <div class="flex items-center gap-2">
          ${dot(oc.status)}
          <span class="text-xs ${oc.status === "ok" ? "text-zinc-400" : "text-zinc-500"}">${oc.status === "ok" ? "Agent running" : oc.status === "paused" ? "Agent paused" : "Agent unavailable"}</span>
        </div>
      </a>`).join("")}

      <a href="/settings" class="bg-surface-card border border-border rounded-lg p-4 hover:border-zinc-500 transition-colors block">
        <div class="flex items-center gap-2 mb-1">
          ${dot(c.telegram.status)}
          <span class="text-xs text-zinc-400">Telegram</span>
        </div>
        <p class="text-sm text-white">${c.telegram.status === "ok" ? "Connected" : c.telegram.status === "not_configured" ? "Not set up yet" : escapeHtml(c.telegram.message || "Error")}</p>
      </a>

      <div class="bg-surface-card border border-border rounded-lg p-4">
        <div class="flex items-center gap-2 mb-1">
          ${dot(c.vault.status)}
          <span class="text-xs text-zinc-400">Secrets</span>
        </div>
        <p class="text-sm text-white">${c.vault.secrets} stored</p>
      </div>

      <a href="/jobs" class="bg-surface-card border border-border rounded-lg p-4 hover:border-zinc-500 transition-colors block">
        <div class="flex items-center gap-2 mb-1">
          ${dot(c.scheduler.status)}
          <span class="text-xs text-zinc-400">Tasks</span>
        </div>
        <p class="text-sm text-white">${c.scheduler.reminders} scheduled</p>
      </a>
    </div>

    <div class="bg-surface-card border border-border rounded-lg p-5 mb-8">
      <h2 class="text-sm font-medium text-white mb-1">Add User</h2>
      <p class="text-xs text-zinc-500 mb-3">Each user gets their own agent, Telegram link, and integrations.</p>
      <form method="POST" action="/users/add" class="flex gap-2 items-end">
        ${hiddenCsrf(csrfToken)}
        <input type="text" name="name" placeholder="Name (e.g. robert)" required
          class="flex-1 px-3 py-2 bg-surface border border-border rounded-lg text-sm text-white placeholder-zinc-600 focus:border-border-focus focus:outline-none">
        <button type="submit"
          class="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors whitespace-nowrap">Add</button>
      </form>
    </div>

    <div class="text-xs text-zinc-600 text-center">Uptime: ${formatUptime(uptime)}</div>
  `);
}

export function renderSettings(telegramBotToken: string | null, steveVersion: string, csrfToken: string, error?: string): string {
  const errorHtml = error ? flash(error, "error") : "";
  return layout("Settings", `
    ${nav(csrfToken)}
    <div class="flex items-center justify-between mb-8">
      <div>
        <h1 class="text-xl font-semibold text-white">Settings</h1>
        <p class="text-sm text-zinc-500 mt-1">Global settings shared across all users.</p>
      </div>
    </div>
    ${errorHtml}
    <div class="bg-surface-card border border-border rounded-lg p-5 mb-6">
      <h2 class="text-sm font-medium text-white mb-1">Version</h2>
      <p class="text-xs text-zinc-500">Running <code>${escapeHtml(steveVersion)}</code></p>
    </div>
    <div id="system-secrets" class="bg-surface-card border border-border rounded-lg p-5">
      <h2 class="text-sm font-medium text-white mb-1">Telegram Bot</h2>
      <p class="text-xs text-zinc-500 mb-4">The bot token shared across all users. Change it here if you create a new bot.</p>
      <form method="POST" action="/settings/telegram" class="space-y-4">
        ${hiddenCsrf(csrfToken)}
        <div>
          <label class="block text-sm text-zinc-400 mb-1">Bot token</label>
          <input type="password" name="bot_token" placeholder="Leave blank to keep current token"
            class="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-white font-mono placeholder-zinc-600 focus:border-border-focus focus:outline-none">
          <p class="text-xs text-zinc-600 mt-2">${telegramBotToken ? "Token saved." : "No token saved yet."}</p>
        </div>
        <button type="submit"
          class="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors">Save</button>
      </form>
    </div>
  `);
}

export function renderJobsPage(entries: Array<ScheduledEntry & { nextRunAt: string | null }>, csrfToken: string): string {
  const rows = entries.length === 0
    ? `<p class="text-sm text-zinc-500">No scheduled tasks yet. Steve creates them when you set up reminders or recurring jobs.</p>`
    : entries.map((entry) => {
      const statusLabel = entry.kind === "heartbeat"
        ? "System"
        : entry.disabled
          ? "Paused"
          : entry.lastStatus === "error"
            ? "Error"
            : entry.lastStatus === "ok"
              ? "Healthy"
              : "Scheduled";
      const statusClass = entry.kind === "heartbeat"
        ? "bg-zinc-900 text-zinc-400 border-border"
        : entry.disabled
          ? "bg-zinc-900 text-zinc-400 border-border"
          : entry.lastStatus === "error"
            ? "bg-red-950 text-red-300 border-red-800"
            : entry.lastStatus === "ok"
              ? "bg-emerald-950 text-emerald-300 border-emerald-800"
              : "bg-blue-950 text-blue-300 border-blue-800";
      const schedule = entry.at
        ? `One-off at ${formatDateTime(entry.at, entry.timezone)}`
        : entry.cron
          ? `${escapeHtml(entry.cron)}${entry.timezone ? ` (${escapeHtml(entry.timezone)})` : ""}`
          : "-";
      return `
        <div class="bg-surface-card border border-border rounded-lg p-4">
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap mb-2">
                <a href="/users/${encodeURIComponent(entry.userName)}" class="text-sm font-medium text-white hover:text-blue-300 transition-colors capitalize">${escapeHtml(entry.userName)}</a>
                <span class="text-zinc-700">/</span>
                <span class="text-sm text-zinc-300">${escapeHtml(entry.name)}</span>
                <span class="text-[11px] px-2 py-0.5 rounded-full border ${statusClass}">${statusLabel}</span>
              </div>
              <div class="grid grid-cols-2 gap-3 text-xs text-zinc-500">
                <div><span class="text-zinc-600">Schedule:</span> ${schedule}</div>
                <div><span class="text-zinc-600">Next run:</span> ${escapeHtml(formatDateTime(entry.nextRunAt, entry.timezone))}</div>
                <div><span class="text-zinc-600">Last run:</span> ${escapeHtml(formatDateTime(entry.lastRunAt, entry.timezone))}</div>
                <div><span class="text-zinc-600">Last result:</span> ${escapeHtml(entry.lastStatus ? titleCase(entry.lastStatus) : entry.kind === "heartbeat" ? "Automatic" : "Not run yet")}</div>
              </div>
              ${entry.lastError ? `<p class="text-xs text-red-300 mt-3">${escapeHtml(entry.lastError)}</p>` : ""}
            </div>
            ${entry.kind === "job" ? `
            <div class="flex gap-2 flex-shrink-0">
              <form method="POST" action="/jobs/toggle" class="inline">
                ${hiddenCsrf(csrfToken)}
                <input type="hidden" name="user" value="${escapeHtml(entry.userName)}">
                <input type="hidden" name="id" value="${escapeHtml(entry.id)}">
                <input type="hidden" name="disabled" value="${entry.disabled ? "false" : "true"}">
                <button type="submit" class="px-3 py-1.5 text-xs rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors">${entry.disabled ? "Resume" : "Pause"}</button>
              </form>
              <form method="POST" action="/jobs/delete" class="inline" onsubmit="return confirm('Delete ${escapeHtml(entry.name)}?')">
                ${hiddenCsrf(csrfToken)}
                <input type="hidden" name="user" value="${escapeHtml(entry.userName)}">
                <input type="hidden" name="id" value="${escapeHtml(entry.id)}">
                <button type="submit" class="px-3 py-1.5 text-xs rounded-md bg-zinc-800 text-zinc-300 hover:bg-red-900 hover:text-red-300 transition-colors">Delete</button>
              </form>
            </div>` : ""}
          </div>
        </div>`;
    }).join("");

  return layout("Tasks", `
    ${nav(csrfToken)}
    <div class="flex items-center justify-between mb-8">
      <div>
        <h1 class="text-xl font-semibold text-white">Tasks</h1>
        <p class="text-sm text-zinc-500 mt-1">Scheduled tasks across all users. Pause or remove them as needed.</p>
      </div>
    </div>
    <div class="space-y-3">${rows}</div>
  `);
}

type UserPageTab = "overview" | "integrations" | "agent";

interface RenderUserOptions {
  agentEnabled?: boolean;
  telegramChatId?: string | null;
  userSecrets?: UserAppSecretSummary[];
  recentActivity?: ActivityEntry[];
  currentModel?: string | null;
  modelProviders?: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>;
}

function renderUserTabs(name: string, activeTab: UserPageTab): string {
  const tabs: Array<{ id: UserPageTab; label: string; href: string }> = [
    { id: "overview", label: "Overview", href: `/users/${encodeURIComponent(name)}` },
    { id: "integrations", label: "Integrations", href: `/users/${encodeURIComponent(name)}/integrations` },
    { id: "agent", label: "Agent", href: `/users/${encodeURIComponent(name)}/agent` },
  ];

  return `
    <div class="flex gap-2 mb-6 overflow-x-auto pb-1">
      ${tabs.map((tab) => `
        <a href="${tab.href}" class="px-3 py-1.5 text-sm rounded-full border transition-colors whitespace-nowrap ${activeTab === tab.id ? "bg-zinc-100 text-zinc-900 border-zinc-100" : "bg-surface-card text-zinc-400 border-border hover:text-white hover:border-zinc-600"}">
          ${tab.label}
        </a>`).join("")}
    </div>`;
}

function renderUserHeader(name: string, ocStatus: string, agentEnabled: boolean, csrfToken: string): string {
  const isRunning = ocStatus === "running";
  const isEnabled = agentEnabled;
  const dot = isRunning
    ? '<span class="inline-block w-2 h-2 rounded-full bg-emerald-400"></span>'
    : isEnabled
      ? '<span class="inline-block w-2 h-2 rounded-full bg-amber-400"></span>'
    : '<span class="inline-block w-2 h-2 rounded-full bg-zinc-600"></span>';
  const statusLabel = isRunning ? "Running" : isEnabled ? "Unavailable" : "Paused";
  return `
    <a href="/" class="text-sm text-zinc-500 hover:text-zinc-300 transition-colors">&larr; Dashboard</a>

    <div class="flex items-center justify-between mt-4 mb-6 gap-4">
      <div class="flex items-center gap-3">
        ${dot}
        <h1 class="text-xl font-semibold text-white capitalize">${escapeHtml(name)}</h1>
        <span class="text-xs ${isRunning ? "text-emerald-400" : isEnabled ? "text-amber-300" : "text-zinc-500"}">${statusLabel}</span>
      </div>
      <div class="flex gap-2">
        ${isEnabled ? `
          <form method="POST" action="/users/${encodeURIComponent(name)}/stop" class="inline">
            ${hiddenCsrf(csrfToken)}
            <button type="submit" class="px-3 py-1.5 text-xs rounded-md bg-zinc-800 text-zinc-300 hover:bg-red-900 hover:text-red-300 transition-colors">Stop</button>
          </form>
          <form method="POST" action="/users/${encodeURIComponent(name)}/${isRunning ? "restart" : "start"}" class="inline">
            ${hiddenCsrf(csrfToken)}
            <button type="submit" class="px-3 py-1.5 text-xs rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors">${isRunning ? "Restart" : "Start"}</button>
          </form>
        ` : `
          <form method="POST" action="/users/${encodeURIComponent(name)}/start" class="inline">
            ${hiddenCsrf(csrfToken)}
            <button type="submit" class="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors">Start Agent</button>
          </form>
        `}
      </div>
    </div>`;
}

function renderUserFrame(name: string, ocStatus: string, csrfToken: string, activeTab: UserPageTab, body: string, options?: RenderUserOptions): string {
  return layout(`${name}`, `
    ${nav(csrfToken)}
    ${renderUserHeader(name, ocStatus, options?.agentEnabled ?? false, csrfToken)}
    ${renderUserTabs(name, activeTab)}
    ${body}
  `);
}

export function renderUserOverview(name: string, ocStatus: string, csrfToken: string, options?: RenderUserOptions): string {
  const telegramConnected = !!options?.telegramChatId;
  const integrationCount = options?.userSecrets?.length || 0;
  return renderUserFrame(name, ocStatus, csrfToken, "overview", `
    <div class="bg-surface-card border border-border rounded-lg p-5 mb-6">
      <div class="flex items-center justify-between gap-4 mb-4">
        <div>
          <h2 class="text-sm font-medium text-white">Connections</h2>
          <p class="text-xs text-zinc-500 mt-1">Link Telegram so Steve can message this user directly.</p>
        </div>
        <span class="text-xs px-2.5 py-1 rounded-full ${telegramConnected ? "bg-emerald-950 text-emerald-300 border border-emerald-800" : "bg-zinc-900 text-zinc-400 border border-border"}">
          Telegram ${telegramConnected ? "connected" : "not connected"}
        </span>
      </div>
      <form method="POST" action="/users/${encodeURIComponent(name)}/telegram" class="flex gap-3 items-end">
        ${hiddenCsrf(csrfToken)}
        <div class="flex-1">
          <label class="block text-sm text-zinc-400 mb-1">Telegram chat ID</label>
          <input type="text" name="telegram_id" placeholder="Get it from @userinfobot" value="${escapeHtml(options?.telegramChatId || "")}"
            class="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-white font-mono placeholder-zinc-600 focus:border-border-focus focus:outline-none">
        </div>
        <button type="submit"
          class="px-4 py-2 text-sm rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors whitespace-nowrap">${telegramConnected ? "Update Telegram" : "Connect Telegram"}</button>
      </form>
      <p class="text-xs text-zinc-600 mt-2">Open Telegram, message <strong class="text-zinc-400">@userinfobot</strong>, and it will reply with your chat ID. Paste it above.</p>
    </div>

    <div class="grid grid-cols-2 gap-3 mb-6">
      <a href="/users/${encodeURIComponent(name)}/integrations" class="bg-surface-card border border-border rounded-lg p-4 hover:border-zinc-600 transition-colors">
        <h2 class="text-sm font-medium text-white mb-1">Integrations</h2>
        <p class="text-xs text-zinc-500">${integrationCount === 0 ? "None configured yet" : `${integrationCount} configured`}</p>
      </a>
      <a href="/users/${encodeURIComponent(name)}/agent" class="bg-surface-card border border-border rounded-lg p-4 hover:border-zinc-600 transition-colors">
        <h2 class="text-sm font-medium text-white mb-1">Agent</h2>
        <p class="text-xs text-zinc-500">${ocStatus === "running" ? "View model, sessions, and logs" : "Start the agent to view its status"}</p>
      </a>
    </div>

    <div class="bg-surface-card border border-border rounded-lg p-5">
      <div class="flex items-center justify-between gap-4 mb-4">
        <div>
          <h2 class="text-sm font-medium text-white">Recent Activity</h2>
          <p class="text-xs text-zinc-500 mt-1">What Steve has been doing for this user recently.</p>
        </div>
      </div>
      <div>
        ${renderActivityItems(options?.recentActivity || [])}
      </div>
    </div>
  `, options);
}

export function renderUserIntegrationsPage(name: string, ocStatus: string, csrfToken: string, options?: RenderUserOptions): string {
  const secrets = options?.userSecrets || [];
  const secretsHtml = secrets.length === 0
    ? `<p class="text-sm text-zinc-500">No integrations yet. Add one to give Steve access to third-party services.</p>`
    : secrets.map((secret) => `
      <div class="bg-surface border border-border rounded-lg p-4">
        <div class="flex items-start justify-between gap-4">
          <div>
            <h3 class="text-sm font-medium text-white">${escapeHtml(titleCase(secret.integration))}</h3>
            <p class="text-xs text-zinc-500 mt-1">${escapeHtml(secret.fields.join(", "))}</p>
          </div>
          <div class="flex gap-2 flex-shrink-0">
            <a href="/users/${encodeURIComponent(name)}/integrations/${encodeURIComponent(secret.integration)}/edit"
              class="px-3 py-1.5 text-xs rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors">Edit</a>
            <form method="POST" action="/users/${encodeURIComponent(name)}/integrations/${encodeURIComponent(secret.integration)}/delete" class="inline" onsubmit="return confirm('Delete ${escapeHtml(titleCase(secret.integration))}?')">
              ${hiddenCsrf(csrfToken)}
              <button type="submit"
                class="px-3 py-1.5 text-xs rounded-md bg-zinc-800 text-zinc-300 hover:bg-red-900 hover:text-red-300 transition-colors">Delete</button>
            </form>
          </div>
        </div>
      </div>`).join("");
  return renderUserFrame(name, ocStatus, csrfToken, "integrations", `
    <div class="bg-surface-card border border-border rounded-lg p-5">
      <div class="flex items-center justify-between gap-4 mb-4">
        <div>
          <h2 class="text-sm font-medium text-white">Integrations</h2>
          <p class="text-xs text-zinc-500 mt-1">API keys and credentials Steve needs to connect to third-party services for this user.</p>
        </div>
        <a href="/users/${encodeURIComponent(name)}/integrations/new"
          class="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors whitespace-nowrap">Add Integration</a>
      </div>
      <div class="space-y-3">
        ${secretsHtml}
      </div>
    </div>
  `, options);
}

export function renderUserAgentPage(name: string, ocStatus: string, ocUrl: string, csrfToken: string, options?: RenderUserOptions): string {
  const providers = options?.modelProviders || [];
  const currentModel = options?.currentModel || "";
  const [currentProvider, currentModelId] = currentModel.includes("/")
    ? [currentModel.split("/")[0] || "", currentModel.slice(currentModel.indexOf("/") + 1)]
    : ["", currentModel];
  const providerOptions = providers.map((provider) => `<option value="${escapeHtml(provider.id)}" ${provider.id === currentProvider ? "selected" : ""}>${escapeHtml(provider.name)}</option>`).join("");
  const modelMap = JSON.stringify(Object.fromEntries(providers.map((provider) => [provider.id, provider.models]))).replace(/</g, "\\u003c");

  return renderUserFrame(name, ocStatus, csrfToken, "agent", `
    <div class="bg-surface-card border border-border rounded-lg p-5 mb-6">
      <div class="mb-4">
        <div>
          <h2 class="text-sm font-medium text-white mb-1">AI Model</h2>
          <p class="text-xs text-zinc-500">The model Steve uses when responding to Telegram messages and running background tasks for this user.</p>
        </div>
      </div>
      ${currentModel ? `
      <div class="flex items-center gap-3 mb-4 px-3 py-2.5 bg-surface rounded-lg border border-border">
        <span class="inline-block w-2 h-2 rounded-full bg-emerald-400"></span>
        <span class="text-sm text-zinc-200 font-mono break-all">${escapeHtml(currentModel)}</span>
      </div>
      ` : ""}
      ${providers.length > 0 ? `
      ${!currentModel ? `<p class="text-xs text-zinc-500 mb-3">Pick a provider and model below, then save to get started.</p>` : ""}
      <form method="POST" action="/users/${encodeURIComponent(name)}/agent/model" class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-3 items-end">
        ${hiddenCsrf(csrfToken)}
        <div>
          <label class="block text-sm text-zinc-400 mb-1">Provider</label>
          <select id="provider_id" name="provider_id" class="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-white focus:border-border-focus focus:outline-none">
            ${providerOptions}
          </select>
        </div>
        <div>
          <label class="block text-sm text-zinc-400 mb-1">Model</label>
          <select id="model_id_select" class="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-white focus:border-border-focus focus:outline-none"></select>
          <input type="hidden" id="model_id" name="model_id" value="${escapeHtml(currentModelId || "")}">
        </div>
        <button type="submit" class="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors whitespace-nowrap">Save</button>
      </form>
      <p class="text-xs text-zinc-600 mt-3">${currentModel ? "The agent restarts automatically after saving so changes take effect right away." : "Steve will restart the agent after saving."}</p>
      ` : `
      <p class="text-xs text-zinc-500">No models available yet. Start the agent first — providers and models will appear once the runtime is ready.</p>
      `}
    </div>

    ${ocUrl ? `
    <div class="bg-surface-card border border-border rounded-lg overflow-hidden mb-6">
      <div class="flex items-center justify-between px-5 py-3 border-b border-border">
        <h2 class="text-sm font-medium text-white">Sessions</h2>
        <a href="${ocUrl}/L2RhdGE" target="_blank"
          class="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">Open in new tab &nearr;</a>
      </div>
      <p class="text-xs text-zinc-600 px-5 py-2">Live view of the agent's coding environment. Click the project name (top-left) and search <code>//data</code> to browse past sessions.</p>
      <iframe src="${ocUrl}" class="w-full border-0" style="height:600px"></iframe>
    </div>` : `
    <div class="bg-surface-card border border-border rounded-lg p-5 mb-6">
      <h2 class="text-sm font-medium text-white mb-2">Sessions</h2>
      <p class="text-sm text-zinc-500">Start the agent to view live sessions here.</p>
    </div>`}

    <div class="bg-surface-card border border-border rounded-lg p-5">
      <h2 class="text-sm font-medium text-white mb-1">Logs</h2>
      <p class="text-xs text-zinc-600 mb-3">Recent output from this user's agent. Updates every few seconds.</p>
      <pre id="logs" class="bg-black/50 rounded-lg p-4 text-xs text-zinc-400 font-mono overflow-auto max-h-60 whitespace-pre-wrap">Loading...</pre>
    </div>

    <script>
      const modelOptionsByProvider = ${modelMap};
      const providerSelect = document.getElementById('provider_id');
      const modelSelect = document.getElementById('model_id_select');
      const modelInput = document.getElementById('model_id');

      function renderModelOptions() {
        if (!providerSelect || !modelSelect || !modelInput) return;
        const providerId = providerSelect.value;
        const models = modelOptionsByProvider[providerId] || [];
        modelSelect.innerHTML = models.map((model) => '<option value="' + model.id + '">' + model.name + '</option>').join('');
        const current = modelInput.value;
        if (current && models.some((model) => model.id === current)) {
          modelSelect.value = current;
        }
        if (!modelSelect.value && models.length > 0) {
          modelSelect.value = models[0].id;
        }
        modelInput.value = modelSelect.value || '';
      }

      if (providerSelect && modelSelect && modelInput) {
        providerSelect.addEventListener('change', renderModelOptions);
        modelSelect.addEventListener('change', () => { modelInput.value = modelSelect.value || ''; });
        renderModelOptions();
      }

      async function loadLogs() {
        try {
          const r = await fetch('/users/${encodeURIComponent(name)}/logs');
          const d = await r.json();
          document.getElementById('logs').textContent = d.logs || 'No logs';
          document.getElementById('logs').scrollTop = document.getElementById('logs').scrollHeight;
        } catch(e) { document.getElementById('logs').textContent = 'Error loading logs'; }
      }
      loadLogs();
      setInterval(loadLogs, 5000);
    </script>
  `, options);
}

export function renderUserSecretNewForm(userName: string, error: string | undefined, csrfToken: string, integration = ""): string {
  const errorHtml = error ? flash(error, "error") : "";
  return layout(`Add Integration`, `
    ${nav(csrfToken)}
    <a href="/users/${encodeURIComponent(userName)}/integrations" class="text-sm text-zinc-500 hover:text-zinc-300 transition-colors">&larr; Integrations</a>
    <h1 class="text-xl font-semibold text-white mt-4 mb-6">Add Integration for ${escapeHtml(userName)}</h1>
    ${errorHtml}
    <form method="POST" action="/users/${encodeURIComponent(userName)}/integrations">
      ${hiddenCsrf(csrfToken)}
      <div>
        <label class="block text-sm text-zinc-400 mb-1">Integration name</label>
        <input type="text" id="integration" name="integration" placeholder="e.g. withings" required value="${escapeHtml(integration)}"
          class="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-white font-mono placeholder-zinc-600 focus:border-border-focus focus:outline-none">
        <p class="text-xs text-zinc-600 mt-2">A short name like <code>withings</code> or <code>weather</code>.</p>
      </div>

      <div class="mt-6">
        <label class="block text-sm text-zinc-400 mb-1">Fields</label>
        <p class="text-xs text-zinc-600 mb-3">Add the credentials this integration needs (e.g. API keys, client secrets). OAuth tokens are stored automatically during login.</p>
        <div id="fields">
          <div class="flex gap-2 items-center mt-2 group">
            <input type="text" name="field_name_0" placeholder="e.g. client_id" required
              class="flex-none w-36 px-3 py-2 bg-surface border border-border rounded-lg text-sm text-white font-mono placeholder-zinc-600 focus:border-border-focus focus:outline-none">
            <input type="password" name="field_value_0" placeholder="value" required
              class="flex-1 px-3 py-2 bg-surface border border-border rounded-lg text-sm text-white font-mono placeholder-zinc-600 focus:border-border-focus focus:outline-none">
            <button type="button" onclick="this.parentElement.remove()"
              class="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 transition-opacity px-1 text-lg">&times;</button>
          </div>
          <div class="flex gap-2 items-center mt-2 group">
            <input type="text" name="field_name_1" placeholder="e.g. client_secret"
              class="flex-none w-36 px-3 py-2 bg-surface border border-border rounded-lg text-sm text-white font-mono placeholder-zinc-600 focus:border-border-focus focus:outline-none">
            <input type="password" name="field_value_1" placeholder="value"
              class="flex-1 px-3 py-2 bg-surface border border-border rounded-lg text-sm text-white font-mono placeholder-zinc-600 focus:border-border-focus focus:outline-none">
            <button type="button" onclick="this.parentElement.remove()"
              class="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 transition-opacity px-1 text-lg">&times;</button>
          </div>
        </div>
        <button type="button" onclick="addField()"
          class="mt-3 px-3 py-1.5 text-xs rounded-md bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-300 transition-colors">+ Add field</button>
      </div>

      <div class="flex gap-3 mt-8">
        <button type="submit"
          class="px-5 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors">Save</button>
        <a href="/users/${encodeURIComponent(userName)}/integrations"
          class="px-5 py-2 text-sm rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors">Cancel</a>
      </div>
    </form>
    <script>
      let fieldIdx = 2;
      function addField() {
        const row = document.createElement('div');
        row.className = 'flex gap-2 items-center mt-2 group';
        row.innerHTML = '<input type="text" name="field_name_' + fieldIdx + '" placeholder="field name" class="flex-none w-36 px-3 py-2 bg-surface border border-border rounded-lg text-sm text-white font-mono placeholder-zinc-600 focus:border-border-focus focus:outline-none">'
          + '<input type="password" name="field_value_' + fieldIdx + '" placeholder="value" class="flex-1 px-3 py-2 bg-surface border border-border rounded-lg text-sm text-white font-mono placeholder-zinc-600 focus:border-border-focus focus:outline-none">'
          + '<button type="button" onclick="this.parentElement.remove()" class="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 transition-opacity px-1 text-lg">&times;</button>';
        document.getElementById('fields').appendChild(row);
        fieldIdx++;
      }
    </script>
  `);
}

export function renderUserSecretEditForm(userName: string, integration: string, fields: [string, string][], error: string | undefined, csrfToken: string): string {
  const errorHtml = error ? flash(error, "error") : "";
  const nextIdx = fields.length;
  return layout(`Edit ${integration}`, `
    ${nav(csrfToken)}
    <a href="/users/${encodeURIComponent(userName)}/integrations" class="text-sm text-zinc-500 hover:text-zinc-300 transition-colors">&larr; Integrations</a>
    <h1 class="text-xl font-semibold text-white mt-4 mb-6">Edit ${escapeHtml(titleCase(integration))}</h1>
    ${errorHtml}
    <form method="POST" action="/users/${encodeURIComponent(userName)}/integrations/${encodeURIComponent(integration)}">
      ${hiddenCsrf(csrfToken)}
      <div>
        <label class="block text-sm text-zinc-400 mb-1">Fields</label>
        <p class="text-xs text-zinc-600 mb-3">Secret values are hidden. Enter a new value only for fields you want to replace.</p>
        <div id="fields">
          ${fieldRows(fields, { maskValues: true })}
        </div>
        <button type="button" onclick="addField()"
          class="mt-3 px-3 py-1.5 text-xs rounded-md bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-300 transition-colors">+ Add field</button>
      </div>

      <div class="flex gap-3 mt-8">
        <button type="submit"
          class="px-5 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors">Save</button>
        <a href="/users/${encodeURIComponent(userName)}/integrations"
          class="px-5 py-2 text-sm rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors">Cancel</a>
      </div>
    </form>
    <script>
      let fieldIdx = ${nextIdx};
      function addField() {
        const row = document.createElement('div');
        row.className = 'flex gap-2 items-center mt-2 group';
        row.innerHTML = '<input type="text" name="field_name_' + fieldIdx + '" placeholder="field name" class="flex-none w-36 px-3 py-2 bg-surface border border-border rounded-lg text-sm text-white font-mono placeholder-zinc-600 focus:border-border-focus focus:outline-none">'
          + '<input type="password" name="field_value_' + fieldIdx + '" placeholder="value" class="flex-1 px-3 py-2 bg-surface border border-border rounded-lg text-sm text-white font-mono placeholder-zinc-600 focus:border-border-focus focus:outline-none">'
          + '<button type="button" onclick="this.parentElement.remove()" class="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 transition-opacity px-1 text-lg">&times;</button>';
        document.getElementById('fields').appendChild(row);
        fieldIdx++;
      }
    </script>
  `);
}

export function renderSetup(options: { needsVaultPassword: boolean; csrfToken: string; error?: string; authOnly?: boolean }): string {
  const { needsVaultPassword, csrfToken, error, authOnly } = options;
  const errorHtml = error ? flash(error, "error") : "";
  const input = "w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-white font-mono placeholder-zinc-600 focus:border-border-focus focus:outline-none";
  const passwordHelp = authOnly
    ? "Your restored data is already in place. Set the dashboard password to finish setup."
    : needsVaultPassword
    ? "This password protects your secrets and signs you into the dashboard."
    : "Choose your dashboard password. You can reuse your existing vault password.";

  return layout("Setup", `
    <div class="text-center mb-8">
      <h1 class="text-2xl font-semibold text-white">Welcome to Steve</h1>
      <p class="text-sm text-zinc-500 mt-2">${authOnly ? "Your backup is restored. Finish dashboard setup to continue." : "Let's get you set up. This takes about 2 minutes."}</p>
    </div>
    ${errorHtml}
    <form method="POST" action="/setup" class="space-y-8">
      ${hiddenCsrf(csrfToken)}

      <div class="bg-surface-card border border-border rounded-lg p-5">
        <h2 class="text-sm font-medium text-white mb-1">Step 1 — Create a password</h2>
        <p class="text-xs text-zinc-500 mb-4">
          ${passwordHelp}
          Steve stays unlocked after normal restarts.
        </p>
        <div class="space-y-3">
          <input type="password" name="password" placeholder="Password (8+ characters)" required minlength="8"
            class="${input}">
          <input type="password" name="confirm_password" placeholder="Confirm password" required
            class="${input}">
        </div>
      </div>

      ${authOnly ? "" : `
      <div class="bg-surface-card border border-border rounded-lg p-5">
        <h2 class="text-sm font-medium text-white mb-1">Step 2 — Set up Telegram</h2>
        <ol class="text-xs text-zinc-500 mb-4 space-y-1 list-decimal list-inside">
          <li>Open Telegram and message <strong class="text-zinc-300">@BotFather</strong></li>
          <li>Send <code class="text-blue-400">/newbot</code> and follow the prompts</li>
          <li>Copy the bot token and paste it below</li>
        </ol>
        <input type="text" name="bot_token" placeholder="123456789:ABCdef..." required
          class="${input}">
      </div>

      <div class="bg-surface-card border border-border rounded-lg p-5">
        <h2 class="text-sm font-medium text-white mb-1">Step 3 — Create your first user</h2>
        <p class="text-xs text-zinc-500 mb-4">
          Pick a name for yourself. After setup you'll connect Telegram on the user page.
          More users can be added later from the dashboard.
        </p>
        <div class="space-y-3">
          <input type="text" name="user_name_0" placeholder="Robert" required
            class="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-white placeholder-zinc-600 focus:border-border-focus focus:outline-none">
        </div>
      </div>`}

      <button type="submit"
        class="w-full py-3 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors font-medium">${authOnly ? "Finish Dashboard Setup" : "Finish Setup"}</button>
    </form>
  `);
}

export function renderSetupComplete(nextUrl = "/", buttonLabel = "Go to Dashboard"): string {
  return layout("Setup Complete", `
    <div class="text-center py-12">
      <div class="w-16 h-16 rounded-full bg-emerald-950 border border-emerald-800 flex items-center justify-center mx-auto mb-6">
        <span class="text-2xl text-emerald-400">&#10003;</span>
      </div>
      <h1 class="text-2xl font-semibold text-white mb-2">You're all set!</h1>
      <p class="text-sm text-zinc-400 mb-4">Next, open your user page and connect Telegram so Steve can reach you.</p>
      <a href="${nextUrl}"
        class="inline-block px-6 py-2.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors font-medium">${buttonLabel}</a>
    </div>
  `);
}

export function renderLogin(error?: string): string {
  const errorHtml = error ? flash(error, "error") : "";
  return layout("Login", `
    <div class="text-center mb-8">
      <h1 class="text-2xl font-semibold text-white">Steve Dashboard</h1>
      <p class="text-sm text-zinc-500 mt-2">Sign in with your dashboard password.</p>
    </div>
    ${errorHtml}
    <form method="POST" action="/login" class="space-y-5 bg-surface-card border border-border rounded-lg p-5">
      <div>
        <label class="block text-sm text-zinc-400 mb-1">Password</label>
        <input type="password" name="password" placeholder="Dashboard password" required minlength="8"
          class="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-white placeholder-zinc-600 focus:border-border-focus focus:outline-none">
      </div>
      <button type="submit"
        class="w-full py-3 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors font-medium">Log in</button>
    </form>
  `);
}

export function renderSetupLocked(): string {
  return layout("Setup Locked", `
    <div class="py-12 text-center">
      <h1 class="text-2xl font-semibold text-white mb-2">Setup link required</h1>
      <p class="text-sm text-zinc-400 mb-6">Open the one-time setup URL from Steve's logs to continue.</p>
      <div class="bg-surface-card border border-border rounded-lg p-4 text-left max-w-md mx-auto mb-4">
        <p class="text-xs uppercase tracking-wide text-zinc-500 mb-3">Run one of these commands</p>
        <div class="space-y-2 text-sm text-zinc-300 font-mono">
          <div>steve setup-url</div>
          <div>steve logs</div>
        </div>
      </div>
      <p class="text-xs text-zinc-600 mb-2">If you already finished setup, go to <a href="/login" class="text-zinc-300 hover:text-white">/login</a>.</p>
      <p class="text-xs text-zinc-700">The setup link is only needed the first time.</p>
    </div>
  `);
}
