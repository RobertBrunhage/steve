// The integration form (create + edit). Shared helper because both modes
// have nearly identical markup.
//
// This is the page end-users (e.g. the user's wife) most commonly land on
// from a Telegram link, so it gets extra UX care: clear member context,
// friendly intro, dynamic field rows powered by Alpine (no inline scripts),
// stack-on-mobile field layout, and a sticky save bar.

import {
  Badge,
  Button,
  Input,
  Section,
  escapeHtml,
  hiddenCsrf,
  inputClass,
} from "../components.js";
import { flash, layout, nav, titleCase } from "./layout.js";

interface IntegrationFormOptions {
  userName: string;
  csrfToken: string;
  mode: "create" | "edit";
  integration: string;        // slug, prefilled or locked
  fields: Array<{ name: string; value: string }>;
  error?: string;
  // When editing, existing values are masked. New value placeholder differs.
  maskValues: boolean;
}

function renderIntegrationForm(opts: IntegrationFormOptions): string {
  const { userName, csrfToken, mode, integration, fields, error, maskValues } = opts;
  const slug = encodeURIComponent(userName);
  const integrationSlug = encodeURIComponent(integration);
  const action = mode === "create"
    ? `/users/${slug}/integrations`
    : `/users/${slug}/integrations/${integrationSlug}`;

  const title = mode === "create" ? "Add integration" : `Edit ${titleCase(integration)}`;
  const introCopy = mode === "create"
    ? "Connect a third-party service so Kellix can use it on your behalf. These credentials stay encrypted in your private vault."
    : "Update the credentials for this integration. Existing values are hidden — leave a field blank to keep the saved value, or type a new one to replace it.";

  const errorHtml = error ? flash(error, "error") : "";

  // Initial Alpine state: an array of {name, value} rows seeded from the
  // server-rendered fields. The form name attributes use the loop index, so
  // re-numbering on add/remove just works with the existing parseFields().
  const initialRows = fields.length > 0
    ? fields
    : [{ name: "", value: "" }, { name: "", value: "" }];
  const alpineState = JSON.stringify({ rows: initialRows }).replace(/</g, "\\u003c");

  // The integration name input — locked to a read-only display when editing,
  // editable (and pre-filled from URL) when creating.
  const integrationField = mode === "create"
    ? `
      ${Input({
        name: "integration",
        label: "Integration name",
        placeholder: "e.g. withings",
        value: integration,
        required: true,
        appearance: "mono",
        hint: "A short slug like <code class=\"text-neutral-600\">withings</code> or <code class=\"text-neutral-600\">weather</code>.",
        autofocus: !integration,
      })}
    `
    : `
      <div>
        <label class="block text-xs text-neutral-500 mb-1">Integration</label>
        <div class="${inputClass} flex items-center justify-between">
          <span class="text-neutral-700 font-mono">${escapeHtml(integration)}</span>
          ${Badge({ tone: "neutral", children: "Locked" })}
        </div>
      </div>
    `;

  const valuePlaceholder = maskValues ? "Leave blank to keep current value" : "value";

  const fieldsBlock = `
    <div x-data='${alpineState}' class="space-y-3">
      <template x-for="(row, i) in rows" :key="i">
        <div class="flex flex-col sm:flex-row gap-2 sm:items-center group rounded-lg sm:rounded-none p-2 sm:p-0 bg-neutral-50 sm:bg-transparent border sm:border-0 border-border">
          <input type="text"
            :name="'field_name_' + i"
            x-model="row.name"
            placeholder="field name (e.g. client_id)"
            class="w-full sm:flex-none sm:w-44 px-3 py-2 bg-surface border border-border rounded-lg text-sm text-neutral-900 font-mono placeholder-neutral-400 focus:border-border-focus focus:outline-none">
          <textarea
            :name="'field_value_' + i"
            x-model="row.value"
            rows="1"
            spellcheck="false"
            autocomplete="off"
            placeholder="${escapeHtml(valuePlaceholder)}"
            class="w-full sm:flex-1 px-3 py-2 bg-surface border border-border rounded-lg text-sm text-neutral-900 font-mono placeholder-neutral-400 focus:border-border-focus focus:outline-none resize-y min-h-[2.5rem]"></textarea>
          <button type="button"
            @click="rows.splice(i, 1)"
            x-show="rows.length > 1"
            class="text-neutral-400 hover:text-red-600 transition-colors text-xs sm:text-lg sm:px-2 self-start sm:self-auto"
            title="Remove field"><span class="sm:hidden">Remove field</span><span class="hidden sm:inline">&times;</span></button>
        </div>
      </template>
      <button type="button"
        @click="rows.push({ name: '', value: '' })"
        class="mt-3 px-3 py-1.5 text-xs rounded-md bg-neutral-100 text-neutral-500 hover:bg-neutral-200 hover:text-neutral-600 transition-colors">
        + Add another field
      </button>
    </div>
  `;

  const formSection = Section({
    title,
    description: introCopy,
    children: `
      <form method="POST" action="${action}" class="space-y-6">
        ${hiddenCsrf(csrfToken)}
        ${integrationField}
        <div>
          <label class="block text-xs text-neutral-500 mb-1">Credentials</label>
          <p class="text-xs text-neutral-400 mb-3">Add the API keys, client secrets, or tokens this integration needs. OAuth tokens are stored automatically when you sign in.</p>
          ${fieldsBlock}
        </div>
        <div class="flex items-center justify-between gap-3 pt-4 border-t border-border">
          ${Button({
            variant: "ghost",
            type: "button",
            href: `/users/${slug}/integrations`,
            children: "Cancel",
          })}
          ${Button({
            variant: "primary",
            children: mode === "create" ? "Save integration" : "Save changes",
          })}
        </div>
      </form>
    `,
  });

  return layout(title, `
    ${nav(csrfToken, "home")}
    <a href="/users/${slug}/integrations" class="text-sm text-neutral-400 hover:text-neutral-600 transition-colors">&larr; ${escapeHtml(userName)}'s integrations</a>
    <div class="mt-4 mb-6 flex items-center gap-3">
      <h1 class="text-xl font-display font-bold text-neutral-900">${escapeHtml(title)}</h1>
      ${Badge({ tone: "neutral", children: `for ${escapeHtml(userName)}` })}
    </div>
    ${errorHtml}
    ${formSection}
  `, { width: "app" });
}

export function renderUserSecretNewForm(userName: string, error: string | undefined, csrfToken: string, integration = ""): string {
  return renderIntegrationForm({
    userName,
    csrfToken,
    mode: "create",
    integration,
    fields: [],
    error,
    maskValues: false,
  });
}

export function renderUserSecretEditForm(userName: string, integration: string, fields: [string, string][], error: string | undefined, csrfToken: string): string {
  return renderIntegrationForm({
    userName,
    csrfToken,
    mode: "edit",
    integration,
    fields: fields.map(([name, value]) => ({ name, value })),
    error,
    maskValues: true,
  });
}
