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
      <a href="/jobs" class="text-sm text-zinc-400 hover:text-white transition-colors">Jobs</a>
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

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderActivityItems(items: ActivityEntry[]): string {
  if (items.length === 0) {
    return `<p class="text-sm text-zinc-500">No recent activity yet.</p>`;
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
        <p class="text-sm text-zinc-500 mt-1">Manage users, integrations, and the household runtime from one place.</p>
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
          <span class="text-xs ${oc.status === "ok" ? "text-zinc-400" : "text-amber-400"}">${oc.status === "ok" ? "Agent running" : "Open user page"}</span>
        </div>
      </a>`).join("")}

      <div class="bg-surface-card border border-border rounded-lg p-4">
        <div class="flex items-center gap-2 mb-1">
          ${dot(c.telegram.status)}
          <span class="text-xs text-zinc-400">Telegram</span>
        </div>
        <p class="text-sm text-white">${c.telegram.status === "ok" ? "Connected" : c.telegram.status === "not_configured" ? "Not configured" : escapeHtml(c.telegram.message || "Error")}</p>
      </div>

      <div class="bg-surface-card border border-border rounded-lg p-4">
        <div class="flex items-center gap-2 mb-1">
          ${dot(c.vault.status)}
          <span class="text-xs text-zinc-400">Vault</span>
        </div>
        <p class="text-sm text-white">${c.vault.secrets} secret${c.vault.secrets === 1 ? "" : "s"}</p>
      </div>

      <div class="bg-surface-card border border-border rounded-lg p-4">
        <div class="flex items-center gap-2 mb-1">
          ${dot(c.scheduler.status)}
          <span class="text-xs text-zinc-400">Scheduler</span>
        </div>
        <p class="text-sm text-white">${c.scheduler.reminders} reminder${c.scheduler.reminders === 1 ? "" : "s"}</p>
      </div>
    </div>

    <div class="bg-surface-card border border-border rounded-lg p-5 mb-8">
      <h2 class="text-sm font-medium text-white mb-3">Add User</h2>
      <form method="POST" action="/users/add" class="flex gap-2 items-end">
        ${hiddenCsrf(csrfToken)}
        <input type="text" name="name" placeholder="User name (e.g. robert)" required
          class="flex-1 px-3 py-2 bg-surface border border-border rounded-lg text-sm text-white placeholder-zinc-600 focus:border-border-focus focus:outline-none">
        <button type="submit"
          class="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors whitespace-nowrap">Add</button>
      </form>
      <p class="text-xs text-zinc-600 mt-2">Create the Steve user first, then open the user page to connect Telegram or other services later.</p>
    </div>

    <div class="text-xs text-zinc-600 text-center">Uptime: ${formatUptime(uptime)}</div>
  `);
}

export function renderSettings(telegramBotToken: string | null, csrfToken: string, error?: string): string {
  const errorHtml = error ? flash(error, "error") : "";
  return layout("Settings", `
    ${nav(csrfToken)}
    <div class="flex items-center justify-between mb-8">
      <div>
        <h1 class="text-xl font-semibold text-white">Settings</h1>
        <p class="text-sm text-zinc-500 mt-1">System-wide settings and credentials that apply to every user.</p>
      </div>
    </div>
    ${errorHtml}
    <div id="system-secrets" class="bg-surface-card border border-border rounded-lg p-5">
      <h2 class="text-sm font-medium text-white mb-1">Telegram</h2>
      <p class="text-xs text-zinc-500 mb-4">This bot token powers Steve globally across all users.</p>
      <form method="POST" action="/settings/telegram" class="space-y-4">
        ${hiddenCsrf(csrfToken)}
        <div>
          <label class="block text-sm text-zinc-400 mb-1">Bot token</label>
          <input type="password" name="bot_token" placeholder="Leave blank to keep current token"
            class="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-white font-mono placeholder-zinc-600 focus:border-border-focus focus:outline-none">
          <p class="text-xs text-zinc-600 mt-2">${telegramBotToken ? "A Telegram bot token is already saved." : "No Telegram bot token saved yet."}</p>
        </div>
        <button type="submit"
          class="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors">Save Telegram Token</button>
      </form>
    </div>
  `);
}

export function renderJobsPage(entries: Array<ScheduledEntry & { nextRunAt: string | null }>, csrfToken: string): string {
  const rows = entries.length === 0
    ? `<p class="text-sm text-zinc-500">No jobs or routines configured yet.</p>`
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
        ? `One-off at ${formatDateTime(entry.at)}`
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
                <div><span class="text-zinc-600">Next run:</span> ${escapeHtml(formatDateTime(entry.nextRunAt))}</div>
                <div><span class="text-zinc-600">Last run:</span> ${escapeHtml(formatDateTime(entry.lastRunAt))}</div>
                <div><span class="text-zinc-600">Last result:</span> ${escapeHtml(entry.lastStatus ? titleCase(entry.lastStatus) : entry.kind === "heartbeat" ? "Managed by Steve" : "Not run yet")}</div>
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

  return layout("Jobs", `
    ${nav(csrfToken)}
    <div class="flex items-center justify-between mb-8">
      <div>
        <h1 class="text-xl font-semibold text-white">Jobs & Routines</h1>
        <p class="text-sm text-zinc-500 mt-1">Inspect scheduled jobs across the household and pause or remove them when needed.</p>
      </div>
    </div>
    <div class="space-y-3">${rows}</div>
  `);
}

type UserPageTab = "overview" | "integrations" | "agent";

interface RenderUserOptions {
  telegramChatId?: string | null;
  userSecrets?: UserAppSecretSummary[];
  recentActivity?: ActivityEntry[];
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

function renderUserHeader(name: string, ocStatus: string, csrfToken: string): string {
  const dot = ocStatus === "running"
    ? '<span class="inline-block w-2 h-2 rounded-full bg-emerald-400"></span>'
    : '<span class="inline-block w-2 h-2 rounded-full bg-red-400"></span>';
  return `
    <a href="/" class="text-sm text-zinc-500 hover:text-zinc-300 transition-colors">&larr; Dashboard</a>

    <div class="flex items-center justify-between mt-4 mb-6 gap-4">
      <div class="flex items-center gap-3">
        ${dot}
        <h1 class="text-xl font-semibold text-white capitalize">${escapeHtml(name)}</h1>
        <span class="text-xs text-zinc-500">${escapeHtml(ocStatus)}</span>
      </div>
      <div class="flex gap-2">
        ${ocStatus === "running" ? `
          <form method="POST" action="/users/${encodeURIComponent(name)}/stop" class="inline">
            ${hiddenCsrf(csrfToken)}
            <button type="submit" class="px-3 py-1.5 text-xs rounded-md bg-zinc-800 text-zinc-300 hover:bg-red-900 hover:text-red-300 transition-colors">Stop</button>
          </form>
          <form method="POST" action="/users/${encodeURIComponent(name)}/restart" class="inline">
            ${hiddenCsrf(csrfToken)}
            <button type="submit" class="px-3 py-1.5 text-xs rounded-md bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors">Restart</button>
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

function renderUserFrame(name: string, ocStatus: string, csrfToken: string, activeTab: UserPageTab, body: string): string {
  return layout(`${name}`, `
    ${nav(csrfToken)}
    ${renderUserHeader(name, ocStatus, csrfToken)}
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
          <p class="text-xs text-zinc-500 mt-1">Connect Telegram so Steve knows where to talk to this user.</p>
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
      <p class="text-xs text-zinc-600 mt-2">Use <strong class="text-zinc-400">@userinfobot</strong> to find the chat ID, then paste it here once.</p>
    </div>

    <div class="grid grid-cols-2 gap-3 mb-6">
      <a href="/users/${encodeURIComponent(name)}/integrations" class="bg-surface-card border border-border rounded-lg p-4 hover:border-zinc-600 transition-colors">
        <h2 class="text-sm font-medium text-white mb-1">Integrations</h2>
        <p class="text-xs text-zinc-500">${integrationCount === 0 ? "No integrations saved yet" : `${integrationCount} integration${integrationCount === 1 ? "" : "s"} configured`}</p>
      </a>
      <a href="/users/${encodeURIComponent(name)}/agent" class="bg-surface-card border border-border rounded-lg p-4 hover:border-zinc-600 transition-colors">
        <h2 class="text-sm font-medium text-white mb-1">Agent</h2>
        <p class="text-xs text-zinc-500">${ocStatus === "running" ? "Inspect OpenCode and logs" : "Start the agent to inspect runtime state"}</p>
      </a>
    </div>

    <div class="bg-surface-card border border-border rounded-lg p-5">
      <div class="flex items-center justify-between gap-4 mb-4">
        <div>
          <h2 class="text-sm font-medium text-white">Recent Activity</h2>
          <p class="text-xs text-zinc-500 mt-1">A quick view of recent messages, jobs, and scripts for this user.</p>
        </div>
      </div>
      <div>
        ${renderActivityItems(options?.recentActivity || [])}
      </div>
    </div>
  `);
}

export function renderUserIntegrationsPage(name: string, ocStatus: string, csrfToken: string, options?: RenderUserOptions): string {
  const secrets = options?.userSecrets || [];
  const secretsHtml = secrets.length === 0
    ? `<p class="text-sm text-zinc-500">No integrations saved for this user yet.</p>`
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
          <h2 class="text-sm font-medium text-white">Secrets & Integrations</h2>
          <p class="text-xs text-zinc-500 mt-1">When Steve asks for app credentials in Telegram, add them here. OAuth tokens stay managed behind the scenes.</p>
        </div>
        <a href="/users/${encodeURIComponent(name)}/integrations/new"
          class="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors whitespace-nowrap">Add Integration</a>
      </div>
      <div class="space-y-3">
        ${secretsHtml}
      </div>
    </div>
  `);
}

export function renderUserAgentPage(name: string, ocStatus: string, ocUrl: string, csrfToken: string): string {
  return renderUserFrame(name, ocStatus, csrfToken, "agent", `
    ${ocUrl ? `
    <div class="bg-surface-card border border-border rounded-lg overflow-hidden mb-6">
      <div class="flex items-center justify-between px-5 py-3 border-b border-border">
        <h2 class="text-sm font-medium text-white">OpenCode</h2>
        <a href="${ocUrl}/L2RhdGE" target="_blank"
          class="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">Open in new tab</a>
      </div>
      <p class="text-xs text-zinc-600 px-5 py-2">First time? Click the project name (top-left in OpenCode) and search for <code>//data</code> to see sessions.</p>
      <iframe src="${ocUrl}" class="w-full border-0" style="height:600px"></iframe>
    </div>` : `
    <div class="bg-surface-card border border-border rounded-lg p-5 mb-6">
      <h2 class="text-sm font-medium text-white mb-2">OpenCode</h2>
      <p class="text-sm text-zinc-500">Not available right now. Start the agent to load OpenCode here.</p>
    </div>`}

    <div class="bg-surface-card border border-border rounded-lg p-5">
      <h2 class="text-sm font-medium text-white mb-1">Agent Logs</h2>
      <p class="text-xs text-zinc-600 mb-3">Recent container output for this user's runtime.</p>
      <pre id="logs" class="bg-black/50 rounded-lg p-4 text-xs text-zinc-400 font-mono overflow-auto max-h-60 whitespace-pre-wrap">Loading...</pre>
    </div>

    <script>
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
  `);
}

export function renderUserSecretNewForm(userName: string, error: string | undefined, csrfToken: string, integration = ""): string {
  const errorHtml = error ? flash(error, "error") : "";
  return layout(`Add Integration`, `
    ${nav(csrfToken)}
    <a href="/users/${encodeURIComponent(userName)}/integrations" class="text-sm text-zinc-500 hover:text-zinc-300 transition-colors">&larr; Back to ${escapeHtml(userName)}</a>
    <h1 class="text-xl font-semibold text-white mt-4 mb-6">Add Integration for ${escapeHtml(userName)}</h1>
    ${errorHtml}
    <form method="POST" action="/users/${encodeURIComponent(userName)}/integrations">
      ${hiddenCsrf(csrfToken)}
      <div>
        <label class="block text-sm text-zinc-400 mb-1">Integration name</label>
        <input type="text" id="integration" name="integration" placeholder="e.g. withings" required value="${escapeHtml(integration)}"
          class="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-white font-mono placeholder-zinc-600 focus:border-border-focus focus:outline-none">
        <p class="text-xs text-zinc-600 mt-2">Use a short slug like <code>withings</code> or <code>weather</code>.</p>
      </div>

      <div class="mt-6">
        <label class="block text-sm text-zinc-400 mb-1">Fields</label>
        <p class="text-xs text-zinc-600 mb-3">Add the app credentials this integration needs. Tokens created later during auth are stored automatically.</p>
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
    <a href="/users/${encodeURIComponent(userName)}/integrations" class="text-sm text-zinc-500 hover:text-zinc-300 transition-colors">&larr; Back to ${escapeHtml(userName)}</a>
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
    ? "Use one password for Steve. It protects your vault and signs you into the dashboard."
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
          First create the Steve user name you want to use. After setup, you'll open that user page and connect Telegram there.
          You can add more users later from the dashboard.
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
      <p class="text-sm text-zinc-400 mb-4">Next, connect Telegram for your first user so Steve knows where to talk to you.</p>
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
      <p class="text-sm text-zinc-500 mt-2">Sign in with the household admin password.</p>
    </div>
    ${errorHtml}
    <form method="POST" action="/login" class="space-y-5 bg-surface-card border border-border rounded-lg p-5">
      <div>
        <label class="block text-sm text-zinc-400 mb-1">Password</label>
        <input type="password" name="password" placeholder="Admin password" required minlength="8"
          class="w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-white font-mono placeholder-zinc-600 focus:border-border-focus focus:outline-none">
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
        <p class="text-xs uppercase tracking-wide text-zinc-500 mb-3">How to find it</p>
        <div class="space-y-2 text-sm text-zinc-300 font-mono">
          <div>steve setup-url</div>
          <div>steve logs</div>
          <div>./steve setup-url</div>
          <div>./steve logs</div>
        </div>
      </div>
      <p class="text-xs text-zinc-600 mb-2">If you already finished setup, go to <a href="/login" class="text-zinc-300 hover:text-white">/login</a>.</p>
      <p class="text-xs text-zinc-700">The setup link is only needed the first time.</p>
    </div>
  `);
}
