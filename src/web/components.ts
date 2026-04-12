// Shared UI primitives for Kellix's web admin.
//
// These are plain functions that return HTML strings — no build step, no
// virtual DOM. They exist so pages stop hand-rolling Tailwind classes and the
// app gets a consistent visual vocabulary (one button style, one card, etc).
//
// New pages should compose these helpers. Old pages keep working unchanged
// because the layout still supplies the same `bg-surface` / `border-border`
// Tailwind tokens.

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// JSON serializer that's safe to embed inside an HTML attribute value. Used
// for things like Alpine `x-data='...'` blocks where the value is parsed by
// the browser (HTML entity-decoding) and then by Alpine (JS evaluation).
export function jsonAttr(value: unknown): string {
  return JSON.stringify(value)
    .replace(/&/g, "&amp;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;");
}

// --- Tokens ----------------------------------------------------------------
//
// Injected into `<head>` once via `designTokensStyle()`. New components read
// these via CSS vars; existing pages still use the Tailwind `surface` /
// `border` palette so the look stays consistent during the migration.

export const designTokensStyle = `
  <style>
    :root {
      --bg: #111113;
      --card: #18181b;
      --card-hover: #1e1e22;
      --border: #27272a;
      --border-strong: #3f3f46;
      --border-focus: #3b82f6;
      --text: #fafafa;
      --text-muted: #a1a1aa;
      --text-subtle: #71717a;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --ok: #10b981;
      --warn: #f59e0b;
      --err: #ef4444;
      --radius: 0.5rem;
    }
    [hx-indicator].htmx-request,
    .htmx-request [hx-indicator] { opacity: 1; }
    [hx-indicator] { opacity: 0; transition: opacity 120ms ease; }
    .htmx-swapping { opacity: 0.5; transition: opacity 120ms ease; }
    [x-cloak] { display: none !important; }

    /* Loading state: disable submit buttons + show their spinner whenever
       the surrounding form is mid-request. Pure CSS, no per-button wiring. */
    .htmx-request button[type="submit"] {
      opacity: 0.7;
      pointer-events: none;
    }
    .btn-spinner { display: none; }
    .htmx-request .btn-spinner { display: inline-block; }
    .htmx-request .btn-label { opacity: 0.85; }
    @keyframes btn-spin { to { transform: rotate(360deg); } }
    .btn-spinner svg { animation: btn-spin 0.6s linear infinite; }
  </style>
`;

// --- Atoms -----------------------------------------------------------------

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
export type ButtonSize = "sm" | "md";

const buttonBase =
  "inline-flex items-center justify-center gap-2 font-medium rounded-lg transition-colors whitespace-nowrap focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-surface focus:ring-blue-500/40 disabled:opacity-50 disabled:cursor-not-allowed";

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-blue-600 text-white hover:bg-blue-500",
  secondary: "bg-zinc-800 text-zinc-200 hover:bg-zinc-700",
  ghost: "bg-transparent text-zinc-400 hover:text-white hover:bg-zinc-800/60",
  danger: "bg-zinc-800 text-zinc-300 hover:bg-red-900 hover:text-red-200",
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
};

// A small inline spinner used by submit buttons via the .htmx-request CSS
// hook in designTokensStyle. Hidden by default; revealed when an ancestor
// form is mid-request. No per-button wiring required.
const buttonSpinner = `<span class="btn-spinner mr-1.5"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><circle cx="12" cy="12" r="9" stroke-opacity="0.25"/><path d="M21 12a9 9 0 0 1-9 9"/></svg></span>`;

export function Button(opts: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  type?: "submit" | "button";
  href?: string;
  children: string;
  attrs?: string;
  disabled?: boolean;
  className?: string;
}): string {
  const variant = opts.variant ?? "secondary";
  const size = opts.size ?? "md";
  const cls = `${buttonBase} ${buttonSizes[size]} ${buttonVariants[variant]} ${opts.className ?? ""}`.trim();
  const extra = opts.attrs ?? "";
  if (opts.href) {
    return `<a href="${opts.href}" class="${cls}" ${extra}>${opts.children}</a>`;
  }
  const type = opts.type ?? "submit";
  const disabled = opts.disabled ? "disabled" : "";
  // Submit buttons get a spinner that the .htmx-request class auto-shows.
  // Plain `type="button"` triggers (e.g. the Add-field button) skip it.
  const spinner = type === "submit" ? buttonSpinner : "";
  const label = `<span class="btn-label">${opts.children}</span>`;
  return `<button type="${type}" class="${cls}" ${disabled} ${extra}>${spinner}${label}</button>`;
}

export type Tone = "ok" | "warn" | "danger" | "neutral";

const badgeTones: Record<Tone, string> = {
  ok: "bg-emerald-950 text-emerald-300 border-emerald-800",
  warn: "bg-amber-950 text-amber-300 border-amber-800",
  danger: "bg-red-950 text-red-300 border-red-800",
  neutral: "bg-zinc-900 text-zinc-400 border-border",
};

export function Badge(opts: { tone: Tone; children: string; className?: string }): string {
  const cls = `inline-flex items-center justify-center whitespace-nowrap text-xs px-2.5 py-1 rounded-full border ${badgeTones[opts.tone]} ${opts.className ?? ""}`.trim();
  return `<span class="${cls}">${opts.children}</span>`;
}

export type DotState = "ok" | "warn" | "error" | "off";

const dotColors: Record<DotState, string> = {
  ok: "bg-emerald-400",
  warn: "bg-amber-400",
  error: "bg-red-400",
  off: "bg-zinc-600",
};

export function StatusDot(opts: { state: DotState; className?: string }): string {
  return `<span class="inline-block w-2 h-2 rounded-full ${dotColors[opts.state]} ${opts.className ?? ""}"></span>`;
}

// --- Form fields -----------------------------------------------------------

export type InputAppearance = "default" | "mono";

export const inputClass =
  "w-full px-3 py-2 bg-surface border border-border rounded-lg text-sm text-white placeholder-zinc-600 focus:border-border-focus focus:outline-none transition-colors";

export const inputClassMono = `${inputClass} font-mono`;

export function inputClasses(appearance: InputAppearance = "default"): string {
  return appearance === "mono" ? inputClassMono : inputClass;
}

export function Input(opts: {
  name: string;
  type?: string;
  label?: string;
  placeholder?: string;
  value?: string;
  hint?: string;
  required?: boolean;
  autofocus?: boolean;
  autocomplete?: string;
  appearance?: InputAppearance;
  id?: string;
}): string {
  const type = opts.type ?? "text";
  const id = opts.id ?? opts.name;
  const label = opts.label
    ? `<label for="${escapeHtml(id)}" class="block text-xs text-zinc-400 mb-1">${escapeHtml(opts.label)}</label>`
    : "";
  const value = opts.value !== undefined ? ` value="${escapeHtml(opts.value)}"` : "";
  const placeholder = opts.placeholder ? ` placeholder="${escapeHtml(opts.placeholder)}"` : "";
  const required = opts.required ? " required" : "";
  const autofocus = opts.autofocus ? " autofocus" : "";
  const autocomplete = opts.autocomplete ? ` autocomplete="${escapeHtml(opts.autocomplete)}"` : "";
  const hint = opts.hint ? `<p class="text-xs text-zinc-600 mt-2">${opts.hint}</p>` : "";
  return `
    <div>
      ${label}
      <input type="${type}" id="${escapeHtml(id)}" name="${escapeHtml(opts.name)}"${value}${placeholder}${required}${autofocus}${autocomplete} class="${inputClasses(opts.appearance)}">
      ${hint}
    </div>
  `;
}

export function Select(opts: {
  name: string;
  options: Array<{ value: string; label: string; selected?: boolean }>;
  label?: string;
  id?: string;
  hint?: string;
}): string {
  const id = opts.id ?? opts.name;
  const label = opts.label
    ? `<label for="${escapeHtml(id)}" class="block text-xs text-zinc-400 mb-1">${escapeHtml(opts.label)}</label>`
    : "";
  const hint = opts.hint ? `<p class="text-xs text-zinc-600 mt-2">${opts.hint}</p>` : "";
  const opts_ = opts.options
    .map((o) => `<option value="${escapeHtml(o.value)}"${o.selected ? " selected" : ""}>${escapeHtml(o.label)}</option>`)
    .join("");
  return `
    <div>
      ${label}
      <select id="${escapeHtml(id)}" name="${escapeHtml(opts.name)}" class="${inputClass}">
        ${opts_}
      </select>
      ${hint}
    </div>
  `;
}

// --- Layout primitives -----------------------------------------------------

export function PageHeader(opts: {
  title: string;
  subtitle?: string;
  back?: { href: string; label: string };
  badge?: string;
  actions?: string;
}): string {
  const back = opts.back
    ? `<a href="${opts.back.href}" class="text-sm text-zinc-500 hover:text-zinc-300 transition-colors">&larr; ${escapeHtml(opts.back.label)}</a>`
    : "";
  const subtitle = opts.subtitle
    ? `<p class="text-sm text-zinc-500 mt-1">${escapeHtml(opts.subtitle)}</p>`
    : "";
  const badge = opts.badge ?? "";
  const actions = opts.actions
    ? `<div class="flex gap-2 flex-shrink-0">${opts.actions}</div>`
    : "";
  return `
    ${back}
    <div class="flex items-start justify-between gap-4 ${opts.back ? "mt-4" : ""} mb-6">
      <div class="min-w-0">
        <div class="flex items-center gap-3 flex-wrap">
          <h1 class="text-xl font-semibold text-white">${escapeHtml(opts.title)}</h1>
          ${badge}
        </div>
        ${subtitle}
      </div>
      ${actions}
    </div>
  `;
}

export function Section(opts: {
  title?: string;
  description?: string;
  badge?: string;
  actions?: string;
  children: string;
  className?: string;
}): string {
  const head = (opts.title || opts.description || opts.badge || opts.actions)
    ? `
      <div class="flex items-start justify-between gap-4 mb-4">
        <div class="min-w-0">
          ${opts.title ? `<h2 class="text-sm font-medium text-white">${escapeHtml(opts.title)}</h2>` : ""}
          ${opts.description ? `<p class="text-xs text-zinc-500 mt-1">${escapeHtml(opts.description)}</p>` : ""}
        </div>
        ${opts.badge ?? ""}
        ${opts.actions ? `<div class="flex gap-2 flex-shrink-0">${opts.actions}</div>` : ""}
      </div>
    `
    : "";
  return `
    <div class="bg-surface-card border border-border rounded-lg p-5 ${opts.className ?? ""}">
      ${head}
      ${opts.children}
    </div>
  `;
}

// A tab strip with two display modes and per-tab status indicators.
// - "underline" (default): admin-panel style, bottom border on active.
// - "pill": rounded chip style, kept for non-page-nav tab strips.
//
// Each item can carry an optional indicator that surfaces state in the tab
// label itself, so users can read the state without clicking through.
export type TabIndicator =
  | { kind: "dot"; state: DotState }
  | { kind: "count"; value: number };

export function Tabs(opts: {
  items: Array<{ key: string; label: string; href: string; indicator?: TabIndicator }>;
  active: string;
  // When set, tab clicks become htmx fragment swaps targeting this selector,
  // instead of full hx-boost page navigations. Lets us swap just the tab
  // body without re-rendering the surrounding nav/header.
  swapTarget?: string;
  variant?: "underline" | "pill";
}): string {
  const variant = opts.variant ?? "underline";

  if (variant === "pill") {
    return `
      <div class="flex gap-2 mb-6 overflow-x-auto pb-1">
        ${opts.items.map((tab) => {
          const active = tab.key === opts.active;
          const cls = active
            ? "bg-zinc-100 text-zinc-900 border-zinc-100"
            : "bg-surface-card text-zinc-400 border-border hover:text-white hover:border-zinc-600";
          const hxAttrs = opts.swapTarget
            ? ` hx-get="${tab.href}" hx-target="${opts.swapTarget}" hx-select="${opts.swapTarget}" hx-swap="outerHTML" hx-push-url="true"`
            : "";
          return `<a href="${tab.href}" class="px-3 py-1.5 text-sm rounded-full border transition-colors whitespace-nowrap ${cls}"${hxAttrs}>${escapeHtml(tab.label)}${renderTabIndicator(tab.indicator)}</a>`;
        }).join("")}
      </div>
    `;
  }

  // underline variant.
  // overflow-y-hidden suppresses the phantom vertical scrollbar that some
  // browsers add when overflow-x-auto is set on a flex container with
  // negative-margin (-mb-px) children.
  return `
    <div class="flex gap-6 mb-6 border-b border-border overflow-x-auto overflow-y-hidden">
      ${opts.items.map((tab) => {
        const active = tab.key === opts.active;
        const cls = active
          ? "border-blue-500 text-white"
          : "border-transparent text-zinc-400 hover:text-white hover:border-zinc-700";
        const hxAttrs = opts.swapTarget
          ? ` hx-get="${tab.href}" hx-target="${opts.swapTarget}" hx-select="${opts.swapTarget}" hx-swap="outerHTML" hx-push-url="true"`
          : "";
        return `<a href="${tab.href}" class="-mb-px flex items-center gap-2 pb-3 pt-1 text-sm border-b-2 transition-colors whitespace-nowrap ${cls}"${hxAttrs}>${escapeHtml(tab.label)}${renderTabIndicator(tab.indicator)}</a>`;
      }).join("")}
    </div>
  `;
}

function renderTabIndicator(indicator: TabIndicator | undefined): string {
  if (!indicator) return "";
  if (indicator.kind === "dot") {
    return ` <span class="inline-block w-1.5 h-1.5 rounded-full ${dotColors[indicator.state]}"></span>`;
  }
  if (indicator.kind === "count" && indicator.value > 0) {
    return ` <span class="text-[11px] px-1.5 py-px rounded-full bg-zinc-800 text-zinc-400 font-medium tabular-nums">${indicator.value}</span>`;
  }
  return "";
}

export function EmptyState(opts: {
  title: string;
  description?: string;
  action?: string;
}): string {
  return `
    <div class="bg-surface-card border border-border border-dashed rounded-lg p-8 text-center">
      <p class="text-sm text-zinc-300 font-medium">${escapeHtml(opts.title)}</p>
      ${opts.description ? `<p class="text-xs text-zinc-500 mt-2">${escapeHtml(opts.description)}</p>` : ""}
      ${opts.action ? `<div class="mt-4 flex justify-center">${opts.action}</div>` : ""}
    </div>
  `;
}

// --- Helpers ---------------------------------------------------------------

export function hiddenCsrf(csrfToken: string): string {
  return `<input type="hidden" name="_csrf" value="${escapeHtml(csrfToken)}">`;
}
