import {
  Badge,
  Button,
  EmptyState,
  Section,
  escapeHtml,
  hiddenCsrf,
  inputClass,
} from "../components.js";
import { formatDateTime, layout, nav } from "./layout.js";
import type { WorkflowDef, WorkflowInstance } from "../../workflows/types.js";

function statusBadge(status: string): string {
  if (status === "ok") return Badge({ tone: "ok", children: "Completed" });
  if (status === "running") return Badge({ tone: "warn", children: "Running" });
  if (status === "waiting_approval") return Badge({ tone: "warn", children: "Waiting approval" });
  if (status === "error") return Badge({ tone: "danger", children: "Error" });
  if (status === "cancelled") return Badge({ tone: "neutral", children: "Cancelled" });
  return Badge({ tone: "neutral", children: status });
}

export interface WorkflowsListOptions {
  userName: string;
  agentId: string;
  workflows: WorkflowDef[];
  recentRuns: WorkflowInstance[];
  csrfToken: string;
}

export function renderWorkflowsList(opts: WorkflowsListOptions): string {
  const { userName, agentId, workflows, recentRuns, csrfToken } = opts;
  const slug = encodeURIComponent(userName);
  const agentSlug = encodeURIComponent(agentId);
  const back = `<a href="/users/${slug}/agents/${agentSlug}" class="text-sm text-neutral-400 hover:text-neutral-600 transition-colors">&larr; ${escapeHtml(agentId)}</a>`;

  const workflowsSection = Section({
    title: "Workflows",
    description: `Multi-step automations for the ${escapeHtml(agentId)} agent. Each workflow lives at <code>users/${escapeHtml(userName)}/agents/${escapeHtml(agentId)}/workflows/&lt;name&gt;.workflow.yaml</code>.`,
    className: "mb-6",
    children: workflows.length === 0
      ? EmptyState({
          title: "No workflows yet",
          description: "Ask the agent to define one with manage_workflows, or drop a .workflow.yaml file in this folder.",
        })
      : `<div class="space-y-2">${workflows.map((w) => {
          const triggerSummary = (w.triggers ?? []).map((t) => t.cron || t.at || t.every || (t.webhook ? `webhook ${t.webhook}` : "") || (t.event ? `event ${t.event}` : "") || "manual").filter(Boolean).join(", ") || "manual";
          return `<a href="/users/${slug}/agents/${agentSlug}/workflows/${encodeURIComponent(w.name)}" class="block border border-border rounded-lg p-4 hover:border-neutral-400 transition-colors">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="text-sm font-medium text-neutral-900">${escapeHtml(w.name)}</p>
                <p class="text-xs text-neutral-400 mt-1">${escapeHtml(w.description || "")}</p>
                <p class="text-xs text-neutral-400 mt-1">Triggers: <code>${escapeHtml(triggerSummary)}</code> · ${w.steps.length} step${w.steps.length === 1 ? "" : "s"}</p>
              </div>
              <span class="text-xs text-neutral-400">Open &rarr;</span>
            </div>
          </a>`;
        }).join("")}</div>`,
  });

  const recentSection = Section({
    title: "Recent runs",
    description: "Last 20 instance executions across all workflows.",
    children: recentRuns.length === 0
      ? `<p class="text-sm text-neutral-400">No runs yet.</p>`
      : `<div class="space-y-2">${recentRuns.map((r) => `
          <a href="/users/${slug}/agents/${agentSlug}/workflows/${encodeURIComponent(r.workflowName)}/runs/${encodeURIComponent(r.id)}" class="block border border-border rounded-lg p-3 hover:border-neutral-400 transition-colors">
            <div class="flex items-center justify-between gap-3">
              <div class="min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  ${statusBadge(r.status)}
                  <span class="text-sm font-mono text-neutral-700">${escapeHtml(r.workflowName)}</span>
                  <span class="text-xs text-neutral-400">${escapeHtml(formatDateTime(r.startedAt))}</span>
                </div>
                ${r.currentStepId ? `<p class="text-xs text-neutral-400 mt-1">step: ${escapeHtml(r.currentStepId)}</p>` : ""}
                ${r.error ? `<p class="text-xs text-red-600 mt-1">${escapeHtml(r.error.message)}</p>` : ""}
              </div>
              <span class="text-xs text-neutral-400">Open &rarr;</span>
            </div>
          </a>
        `).join("")}</div>`,
  });

  void csrfToken;
  return layout(`${userName}/${agentId} workflows`, `
    ${nav(csrfToken, "home")}
    ${back}
    <h1 class="text-xl font-display font-bold text-neutral-900 mt-4 mb-6">Workflows</h1>
    ${workflowsSection}
    ${recentSection}
  `, { width: "app" });
}

export interface WorkflowDetailOptions {
  userName: string;
  agentId: string;
  workflow: WorkflowDef;
  runs: WorkflowInstance[];
  csrfToken: string;
}

export function renderWorkflowDetail(opts: WorkflowDetailOptions): string {
  const { userName, agentId, workflow, runs, csrfToken } = opts;
  const slug = encodeURIComponent(userName);
  const agentSlug = encodeURIComponent(agentId);
  const wfSlug = encodeURIComponent(workflow.name);

  const stepsBlock = `<div class="space-y-2">${workflow.steps.map((s) => `
    <div class="border border-border rounded-lg p-3">
      <div class="flex items-center gap-2 flex-wrap">
        <code class="text-xs text-neutral-500">${escapeHtml(s.id)}</code>
        <Badge>${escapeHtml(s.type)}</Badge>
      </div>
      ${s.when ? `<p class="text-xs text-neutral-400 mt-1">when: <code>${escapeHtml(s.when)}</code></p>` : ""}
    </div>
  `).join("")}</div>`;

  const recentRuns = `<div class="space-y-2">${runs.map((r) => `
    <a href="/users/${slug}/agents/${agentSlug}/workflows/${wfSlug}/runs/${encodeURIComponent(r.id)}" class="block border border-border rounded-lg p-3 hover:border-neutral-400 transition-colors">
      <div class="flex items-center gap-2 flex-wrap">
        ${statusBadge(r.status)}
        <span class="text-xs text-neutral-400">${escapeHtml(formatDateTime(r.startedAt))}</span>
        ${r.currentStepId ? `<span class="text-xs text-neutral-400">step: ${escapeHtml(r.currentStepId)}</span>` : ""}
      </div>
    </a>
  `).join("")}</div>`;

  const runForm = `
    <form method="POST" action="/users/${slug}/agents/${agentSlug}/workflows/${wfSlug}/run" class="flex items-center justify-between gap-3">
      ${hiddenCsrf(csrfToken)}
      <p class="text-xs text-neutral-400">Manual trigger uses default args.</p>
      ${Button({ variant: "primary", size: "sm", children: "Run now" })}
    </form>
  `;

  return layout(`${workflow.name}`, `
    ${nav(csrfToken, "home")}
    <a href="/users/${slug}/agents/${agentSlug}/workflows" class="text-sm text-neutral-400 hover:text-neutral-600 transition-colors">&larr; Workflows</a>
    <div class="mt-4 mb-6">
      <h1 class="text-xl font-display font-bold text-neutral-900">${escapeHtml(workflow.name)}</h1>
      <p class="text-xs text-neutral-400 mt-2">${escapeHtml(workflow.description || "")}</p>
    </div>
    ${Section({ title: "Trigger", className: "mb-6", children: runForm })}
    ${Section({ title: "Steps", className: "mb-6", children: stepsBlock })}
    ${Section({ title: "Recent runs", children: runs.length > 0 ? recentRuns : `<p class="text-sm text-neutral-400">No runs yet.</p>` })}
  `, { width: "app" });
}

export interface WorkflowRunOptions {
  userName: string;
  agentId: string;
  workflow: WorkflowDef;
  instance: WorkflowInstance;
  csrfToken: string;
}

export function renderWorkflowRun(opts: WorkflowRunOptions): string {
  const { userName, agentId, workflow, instance, csrfToken } = opts;
  const slug = encodeURIComponent(userName);
  const agentSlug = encodeURIComponent(agentId);
  const wfSlug = encodeURIComponent(workflow.name);
  const back = `<a href="/users/${slug}/agents/${agentSlug}/workflows/${wfSlug}" class="text-sm text-neutral-400 hover:text-neutral-600 transition-colors">&larr; ${escapeHtml(workflow.name)}</a>`;

  const approvalForm = instance.status === "waiting_approval" && instance.waiting ? `
    <div class="rounded-lg border border-amber-300 bg-amber-50 p-4 mb-6">
      <p class="text-sm font-medium text-amber-800 mb-2">Awaiting approval</p>
      <p class="text-sm text-amber-900 mb-3">${escapeHtml(instance.waiting.prompt)}</p>
      <form method="POST" action="/users/${slug}/agents/${agentSlug}/workflows/${wfSlug}/runs/${encodeURIComponent(instance.id)}/approve" class="flex flex-wrap gap-2">
        ${hiddenCsrf(csrfToken)}
        ${(instance.waiting.buttons ?? [["Approve", "Deny"]]).flat().map((label) => `
          <button type="submit" name="response" value="${escapeHtml(label)}" class="inline-flex items-center justify-center gap-2 font-medium rounded-lg transition-colors whitespace-nowrap px-3 py-1.5 text-xs border border-amber-400 bg-white text-amber-900 hover:bg-amber-100">${escapeHtml(label)}</button>
        `).join("")}
      </form>
    </div>
  ` : "";

  const stepsBlock = `<div class="space-y-2">${workflow.steps.map((s) => {
    const state = instance.steps[s.id];
    const status = state ? state.status : "pending";
    const tone = status === "ok" ? "ok" : status === "error" ? "danger" : status === "running" || status === "waiting" ? "warn" : "neutral";
    return `
      <div class="border border-border rounded-lg p-3">
        <div class="flex items-center gap-2 flex-wrap">
          ${Badge({ tone, children: status })}
          <code class="text-xs text-neutral-500">${escapeHtml(s.id)}</code>
          <span class="text-xs text-neutral-400">${escapeHtml(s.type)}</span>
          ${state?.attempt && state.attempt > 1 ? `<span class="text-xs text-neutral-400">attempt ${state.attempt}</span>` : ""}
        </div>
        ${state?.stdout ? `<details class="mt-2"><summary class="text-xs text-neutral-500 cursor-pointer">stdout (${state.stdout.length} bytes)</summary><pre class="text-xs bg-neutral-100 rounded p-2 mt-1 overflow-auto max-h-60 whitespace-pre-wrap">${escapeHtml(state.stdout.slice(0, 8192))}</pre></details>` : ""}
        ${state?.json !== undefined ? `<details class="mt-2"><summary class="text-xs text-neutral-500 cursor-pointer">json</summary><pre class="text-xs bg-neutral-100 rounded p-2 mt-1 overflow-auto max-h-60">${escapeHtml(JSON.stringify(state.json, null, 2).slice(0, 8192))}</pre></details>` : ""}
        ${state?.error ? `<p class="text-xs text-red-600 mt-2">${escapeHtml(state.error)}</p>` : ""}
      </div>
    `;
  }).join("")}</div>`;

  return layout(`run ${instance.id.slice(0, 8)}`, `
    ${nav(csrfToken, "home")}
    ${back}
    <div class="mt-4 mb-6">
      <div class="flex items-center gap-2 flex-wrap">
        <h1 class="text-xl font-display font-bold text-neutral-900">Run ${escapeHtml(instance.id.slice(0, 8))}</h1>
        ${statusBadge(instance.status)}
      </div>
      <p class="text-xs text-neutral-400 mt-2">Started ${escapeHtml(formatDateTime(instance.startedAt))}${instance.finishedAt ? ` · finished ${escapeHtml(formatDateTime(instance.finishedAt))}` : ""}</p>
      ${instance.error ? `<p class="text-xs text-red-600 mt-1">${escapeHtml(instance.error.message)}</p>` : ""}
    </div>
    ${approvalForm}
    ${Section({ title: "Steps", children: stepsBlock })}
  `, { width: "app" });
}
