import type { HealthStatus } from "../../health.js";
import {
  Badge,
  Button,
  EmptyState,
  StatusDot,
  escapeHtml,
  hiddenCsrf,
  inputClass,
  type Tone,
} from "../components.js";
import { formatUptime, formatRelative, layout, nav } from "./layout.js";

export interface MemberSummary {
  name: string;
  status: "ok" | "error" | "paused";
  integrationCount: number;
  telegramConnected: boolean;
  lastActivityAt?: string | null;
}

export interface RenderHomeOptions {
  health: HealthStatus;
  members: MemberSummary[];
  csrfToken: string;
}

function renderMemberCard(member: MemberSummary): string {
  const dotState: "ok" | "warn" | "off" = member.status === "ok" ? "ok" : member.status === "error" ? "warn" : "off";
  const statusLabel = member.status === "ok" ? "Agent running" : member.status === "error" ? "Agent unavailable" : "Agent paused";
  const statusTone = member.status === "ok" ? "text-emerald-400" : member.status === "error" ? "text-amber-300" : "text-zinc-500";

  const integrationsLine = member.integrationCount === 0
    ? "No integrations"
    : `${member.integrationCount} integration${member.integrationCount === 1 ? "" : "s"}`;
  const telegramLine = member.telegramConnected ? "Telegram linked" : "Not linked";
  const activityLine = member.lastActivityAt ? `Active ${formatRelative(member.lastActivityAt)}` : "No activity yet";

  return `
    <a href="/users/${encodeURIComponent(member.name)}" class="bg-surface-card border border-border rounded-lg p-5 hover:border-zinc-500 transition-colors block group">
      <div class="flex items-center justify-between mb-3">
        <span class="text-base font-medium text-white capitalize truncate">${escapeHtml(member.name)}</span>
        <span class="text-zinc-600 group-hover:text-zinc-400 transition-colors">&rarr;</span>
      </div>
      <div class="flex items-center gap-2 mb-3">
        ${StatusDot({ state: dotState })}
        <span class="text-xs ${statusTone}">${statusLabel}</span>
      </div>
      <ul class="space-y-1 text-xs text-zinc-500">
        <li>${integrationsLine}</li>
        <li>${telegramLine}</li>
        <li>${activityLine}</li>
      </ul>
    </a>
  `;
}

export function renderHome(opts: RenderHomeOptions): string {
  const { health, members, csrfToken } = opts;
  const { uptime, healthy, components: c } = health;

  // The grid auto-refreshes every 10s via htmx polling. Polls the home page,
  // hx-select grabs just `.member-grid` from the response and swaps it in
  // place — so the activity feed and add-member panel stay untouched.
  const memberGridContent = members.length === 0
    ? EmptyState({
        title: "No members yet",
        description: "Add your first member below to get started.",
      })
    : `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">${members.map(renderMemberCard).join("")}</div>`;

  // hx-disinherit is critical: child elements (the member card links) must
  // NOT inherit hx-target / hx-swap / hx-select from this polling wrapper.
  // Otherwise hx-boost on those links would try to extract `.member-grid`
  // from the user-detail response (which doesn't contain it), and the page
  // would silently fail to render until you refresh.
  const memberGrid = `
    <div class="member-grid"
         hx-get="/"
         hx-trigger="every 10s"
         hx-select=".member-grid"
         hx-swap="outerHTML"
         hx-disinherit="hx-target hx-swap hx-select hx-get hx-trigger">
      ${memberGridContent}
    </div>
  `;

  // The add-member form lives in an Alpine-driven inline panel so the home
  // page stays calm and the form only appears when you ask for it.
  const addMemberPanel = `
    <div x-data="{ open: false }" class="mb-6">
      <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div class="min-w-0">
          <h1 class="text-2xl font-semibold text-white">Members</h1>
          <p class="text-sm text-zinc-500 mt-1">Each member has their own agent, integrations, and Telegram link.</p>
        </div>
        ${Button({
          variant: "primary",
          type: "button",
          attrs: `@click="open = !open" :aria-expanded="open"`,
          className: "flex-shrink-0",
          children: "+ Add member",
        })}
      </div>
      <div x-show="open" x-cloak x-transition.duration.150ms class="bg-surface-card border border-border rounded-lg p-5 mb-4">
        <form method="POST" action="/users/add" class="flex flex-col sm:flex-row gap-3 sm:items-end">
          ${hiddenCsrf(csrfToken)}
          <div class="flex-1">
            <label for="member_name" class="block text-xs text-zinc-400 mb-1">Member name</label>
            <input id="member_name" type="text" name="name" placeholder="e.g. robert" required class="${inputClass}">
            <p class="text-xs text-zinc-600 mt-2">Lowercase letters and dashes only. They'll get their own agent and Telegram link.</p>
          </div>
          ${Button({ variant: "primary", children: "Add member" })}
        </form>
      </div>
    </div>
  `;

  // System health strip — small and quiet, sits at the bottom.
  const telegramTone: Tone = c.telegram.status === "ok" ? "ok" : c.telegram.status === "not_configured" ? "neutral" : "danger";
  const telegramLabel = c.telegram.status === "ok"
    ? "Telegram connected"
    : c.telegram.status === "not_configured"
      ? "Telegram not set up"
      : "Telegram error";
  const overallTone: Tone = healthy ? "ok" : "warn";

  const statusStrip = `
    <div class="mt-10 pt-4 border-t border-border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-xs text-zinc-600">
      <div class="flex items-center gap-2 flex-wrap">
        ${Badge({ tone: overallTone, children: healthy ? "All systems healthy" : "Degraded" })}
        ${Badge({ tone: telegramTone, children: telegramLabel })}
        <span>${c.scheduler.reminders} scheduled task${c.scheduler.reminders === 1 ? "" : "s"}</span>
      </div>
      <span class="text-zinc-700">Uptime ${formatUptime(uptime)}</span>
    </div>
  `;

  return layout("Members", `
    ${nav(csrfToken, "home")}
    ${addMemberPanel}
    ${memberGrid}
    ${statusStrip}
  `, { width: "app" });
}
