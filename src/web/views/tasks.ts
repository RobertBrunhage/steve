import type { ScheduledEntry } from "../../scheduler.js";
import {
  Badge,
  Button,
  EmptyState,
  PageHeader,
  escapeHtml,
  hiddenCsrf,
} from "../components.js";
import { formatDateTime, layout, nav, titleCase } from "./layout.js";

function jobStatusBadge(entry: ScheduledEntry): string {
  if (entry.kind === "heartbeat") return Badge({ tone: "neutral", children: "System" });
  if (entry.disabled) return Badge({ tone: "neutral", children: "Paused" });
  if (entry.lastStatus === "error") return Badge({ tone: "danger", children: "Error" });
  if (entry.lastStatus === "ok") return Badge({ tone: "ok", children: "Healthy" });
  return Badge({ tone: "neutral", children: "Scheduled" });
}

function renderJobRow(entry: ScheduledEntry & { nextRunAt: string | null }, csrfToken: string): string {
  const slug = encodeURIComponent(entry.userName);
  const schedule = entry.at
    ? `One-off at ${formatDateTime(entry.at, entry.timezone)}`
    : entry.cron
      ? `${escapeHtml(entry.cron)}${entry.timezone ? ` (${escapeHtml(entry.timezone)})` : ""}`
      : "—";

  const actions = entry.kind === "job" ? `
    <div class="flex gap-2 flex-shrink-0">
      <form method="POST" action="/jobs/toggle" class="inline">
        ${hiddenCsrf(csrfToken)}
        <input type="hidden" name="user" value="${escapeHtml(entry.userName)}">
        <input type="hidden" name="id" value="${escapeHtml(entry.id)}">
        <input type="hidden" name="disabled" value="${entry.disabled ? "false" : "true"}">
        ${Button({ variant: "secondary", size: "sm", children: entry.disabled ? "Resume" : "Pause" })}
      </form>
      <form method="POST" action="/jobs/delete" class="inline" onsubmit="return confirm('Delete ${escapeHtml(entry.name)}?')">
        ${hiddenCsrf(csrfToken)}
        <input type="hidden" name="user" value="${escapeHtml(entry.userName)}">
        <input type="hidden" name="id" value="${escapeHtml(entry.id)}">
        ${Button({ variant: "danger", size: "sm", children: "Delete" })}
      </form>
    </div>
  ` : "";

  return `
    <div class="bg-surface-card border border-border rounded-lg p-4 hover:border-zinc-600 transition-colors">
      <div class="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 flex-wrap mb-3">
            <a href="/users/${slug}" class="text-sm font-medium text-white hover:text-blue-300 transition-colors capitalize">${escapeHtml(entry.userName)}</a>
            <span class="text-zinc-700">/</span>
            <span class="text-sm text-zinc-300">${escapeHtml(entry.name)}</span>
            ${jobStatusBadge(entry)}
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-zinc-500">
            <div><span class="text-zinc-600">Schedule:</span> ${schedule}</div>
            <div><span class="text-zinc-600">Next run:</span> ${escapeHtml(formatDateTime(entry.nextRunAt, entry.timezone))}</div>
            <div><span class="text-zinc-600">Last run:</span> ${escapeHtml(formatDateTime(entry.lastRunAt, entry.timezone))}</div>
            <div><span class="text-zinc-600">Last result:</span> ${escapeHtml(entry.lastStatus ? titleCase(entry.lastStatus) : entry.kind === "heartbeat" ? "Automatic" : "Not run yet")}</div>
          </div>
          ${entry.lastError ? `<p class="text-xs text-red-300 mt-3">${escapeHtml(entry.lastError)}</p>` : ""}
        </div>
        ${actions}
      </div>
    </div>
  `;
}

export type JobsFilterStatus = "all" | "active" | "paused";

export interface RenderJobsPageOptions {
  entries: Array<ScheduledEntry & { nextRunAt: string | null }>;
  csrfToken: string;
  filterStatus: JobsFilterStatus;
  filterMember: string;        // "all" or a member name
  memberNames: string[];       // for the member filter chips
}

function jobsFilterChip(label: string, href: string, active: boolean): string {
  const cls = active
    ? "bg-zinc-100 text-zinc-900 border-zinc-100"
    : "bg-surface-card text-zinc-400 border-border hover:text-white hover:border-zinc-600";
  return `<a href="${href}" class="px-3 py-1.5 text-xs rounded-full border transition-colors whitespace-nowrap ${cls}">${escapeHtml(label)}</a>`;
}

function jobsFilterUrl(status: JobsFilterStatus, member: string): string {
  const params = new URLSearchParams();
  if (status !== "all") params.set("status", status);
  if (member !== "all") params.set("member", member);
  const qs = params.toString();
  return qs ? `/jobs?${qs}` : "/jobs";
}

export function renderJobsPage(opts: RenderJobsPageOptions): string {
  const { entries, csrfToken, filterStatus, filterMember, memberNames } = opts;

  const statusChips = (["all", "active", "paused"] as const).map((s) => jobsFilterChip(
    s === "all" ? "All" : s === "active" ? "Active" : "Paused",
    jobsFilterUrl(s, filterMember),
    s === filterStatus,
  )).join("");

  const memberChips = ["all", ...memberNames].map((m) => jobsFilterChip(
    m === "all" ? "All members" : m,
    jobsFilterUrl(filterStatus, m),
    m === filterMember,
  )).join("");

  const filterBar = `
    <div class="mb-6 space-y-3">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-xs text-zinc-600 uppercase tracking-wide mr-1">Status</span>
        ${statusChips}
      </div>
      ${memberNames.length > 1 ? `
      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-xs text-zinc-600 uppercase tracking-wide mr-1">Member</span>
        ${memberChips}
      </div>
      ` : ""}
    </div>
  `;

  const body = entries.length === 0
    ? EmptyState({
        title: filterStatus === "all" && filterMember === "all"
          ? "No scheduled tasks yet"
          : "No tasks match these filters",
        description: filterStatus === "all" && filterMember === "all"
          ? "Steve creates tasks automatically when you set up reminders or recurring jobs from Telegram."
          : "Try clearing the filters above.",
      })
    : `<div class="space-y-3">${entries.map((e) => renderJobRow(e, csrfToken)).join("")}</div>`;

  return layout("Tasks", `
    ${nav(csrfToken, "tasks")}
    ${PageHeader({ title: "Tasks", subtitle: "Scheduled tasks across all members. Pause or remove them as needed." })}
    ${filterBar}
    ${body}
  `, { width: "app" });
}
