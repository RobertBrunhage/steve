// Shared layout primitives + helpers used across every page render.
//
// Lives at the bottom of the views/ dependency graph: page modules import
// from here, never the other way around.

import type { ActivityEntry } from "../../activity.js";
import { StatusDot, designTokensStyle, escapeHtml, hiddenCsrf } from "../components.js";

// --- Date/time helpers -----------------------------------------------------

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function formatDateTime(value: string | null | undefined, timeZone?: string | null): string {
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

export function formatRelative(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const diffMs = Date.now() - date.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return formatDateTime(value);
}

export function titleCase(value: string): string {
  return value
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

// --- Inline alert (kept for form-validation messages) ----------------------
//
// Distinct from the toast/flash system in flash.ts. `flash()` here renders
// an inline panel inside a form (used when re-rendering the form with an
// error). Toasts are for non-blocking confirmations after a redirect.

export function flash(message: string, type: "success" | "error" = "success"): string {
  const styles = type === "success"
    ? "bg-emerald-950/50 border-emerald-800 text-emerald-300"
    : "bg-red-950/50 border-red-800 text-red-300";
  return `<div class="border rounded-lg px-4 py-3 mb-6 text-sm ${styles}">${escapeHtml(message)}</div>`;
}

// --- Cross-page activity feed renderer -------------------------------------

export function renderActivityItems(items: ActivityEntry[], opts: { showMember?: boolean } = {}): string {
  if (items.length === 0) {
    return `<p class="text-sm text-zinc-500">Nothing yet. Activity will show up here once Steve starts handling messages or tasks.</p>`;
  }

  return items.map((item) => {
    const dotState: "ok" | "error" | "off" = item.status === "error" ? "error" : item.status === "ok" ? "ok" : "off";
    const memberPrefix = opts.showMember
      ? `<a href="/users/${encodeURIComponent(item.userName)}" class="text-xs font-medium text-zinc-400 hover:text-white capitalize transition-colors">${escapeHtml(item.userName)}</a><span class="text-zinc-700">·</span>`
      : "";
    return `
      <div class="flex items-start gap-3 py-3 border-b border-border last:border-b-0">
        ${StatusDot({ state: dotState, className: "mt-1.5 flex-shrink-0" })}
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 flex-wrap">
            ${memberPrefix}
            <p class="text-sm text-zinc-200 min-w-0 truncate">${escapeHtml(item.summary)}</p>
          </div>
          <p class="text-xs text-zinc-600 mt-1" title="${escapeHtml(formatDateTime(item.timestamp))}">${escapeHtml(formatRelative(item.timestamp))}</p>
        </div>
      </div>`;
  }).join("");
}

// --- Top nav ---------------------------------------------------------------

export type NavKey = "home" | "tasks" | "settings" | null;

export function nav(csrfToken: string, current: NavKey = null): string {
  const link = (href: string, label: string, key: Exclude<NavKey, null>): string => {
    const active = key === current;
    const base = "text-sm transition-colors py-1 border-b-2";
    const cls = active
      ? "text-white border-blue-500 font-medium"
      : "text-zinc-400 border-transparent hover:text-white";
    return `<a href="${href}" class="${base} ${cls}">${label}</a>`;
  };
  return `
  <nav class="flex items-center justify-between gap-3 mb-8 border-b border-border pb-3">
    <div class="flex items-center gap-3 sm:gap-6 min-w-0">
      <a href="/" class="text-sm font-semibold text-white tracking-wide flex-shrink-0">Steve</a>
      <div class="flex gap-3 sm:gap-5">
        ${link("/", "Members", "home")}
        ${link("/jobs", "Tasks", "tasks")}
        ${link("/settings", "Settings", "settings")}
      </div>
    </div>
    <form method="POST" action="/logout" class="inline flex-shrink-0">
      ${hiddenCsrf(csrfToken)}
      <button type="submit" class="text-xs text-zinc-500 hover:text-white transition-colors">Log out</button>
    </form>
  </nav>`;
}

// --- Page shell ------------------------------------------------------------
//
// Two widths only:
//   - "app"  (default): the main app shell, used by every signed-in page so
//     navigation never causes the content area to jump in size.
//   - "auth": tight, centered container for login/welcome screens where wide
//     content would look strange.

export type LayoutWidth = "app" | "auth";
export type LayoutOptions = { width?: LayoutWidth };

const widthClasses: Record<LayoutWidth, string> = {
  app: "max-w-3xl",
  auth: "max-w-md",
};

export const layout = (title: string, body: string, options: LayoutOptions = {}) => {
  const widthClass = widthClasses[options.width ?? "app"];
  return `<!DOCTYPE html>
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
  <script src="https://unpkg.com/htmx.org@2.0.4" integrity="sha384-HGfztofotfshcF7+8n44JQL2oJmowVChPTg48S+jvZoztPfvwD79OC/LTtG6dMp+" crossorigin="anonymous"></script>
  <script defer src="https://unpkg.com/alpinejs@3.14.1/dist/cdn.min.js"></script>
  ${designTokensStyle}
</head>
<body class="dark bg-surface text-zinc-300 min-h-screen" hx-boost="true">
  <div class="${widthClass} mx-auto px-4 py-8">
    ${body}
  </div>
  <div id="toasts" class="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none max-w-sm"></div>
  <script>
    (function () {
      var root = document.getElementById('toasts');
      if (!root) return;
      function showToast(message, tone) {
        if (!message) return;
        var colors = tone === 'error'
          ? 'bg-red-950/95 border-red-800 text-red-200'
          : 'bg-emerald-950/95 border-emerald-800 text-emerald-200';
        var el = document.createElement('div');
        el.className = 'pointer-events-auto rounded-lg border px-4 py-3 text-sm shadow-xl backdrop-blur ' + colors;
        el.style.opacity = '0';
        el.style.transform = 'translateY(-8px)';
        el.style.transition = 'opacity 200ms ease, transform 200ms ease';
        el.textContent = message;
        root.appendChild(el);
        requestAnimationFrame(function () {
          el.style.opacity = '1';
          el.style.transform = 'translateY(0)';
        });
        setTimeout(function () {
          el.style.opacity = '0';
          el.style.transform = 'translateY(-8px)';
          setTimeout(function () { el.remove(); }, 220);
        }, 4000);
      }
      // Read flash cookie on page load (set by full-page POST + redirect handlers).
      var match = document.cookie.match(/(?:^|; )steve_flash=([^;]+)/);
      if (match) {
        document.cookie = 'steve_flash=; Max-Age=0; Path=/';
        try {
          var data = JSON.parse(decodeURIComponent(match[1]));
          showToast(data.message, data.tone || 'ok');
        } catch (e) {}
      }
      // Listen for HX-Trigger events from htmx fragment responses.
      document.body.addEventListener('showToast', function (e) {
        var detail = (e && e.detail) || {};
        showToast(detail.message, detail.tone || 'ok');
      });
    })();
  </script>
</body>
</html>`;
};
