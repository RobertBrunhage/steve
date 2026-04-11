import {
  Badge,
  Button,
  Input,
  PageHeader,
  Section,
  escapeHtml,
  hiddenCsrf,
} from "../components.js";
import { flash, layout, nav } from "./layout.js";

export function renderSettings(telegramBotToken: string | null, steveVersion: string, csrfToken: string, timezone: string, error?: string): string {
  const errorHtml = error ? flash(error, "error") : "";

  const telegramSection = Section({
    title: "Telegram bot",
    description: "The bot token shared across all members. Change it here if you create a new bot.",
    badge: Badge({ tone: telegramBotToken ? "ok" : "neutral", children: telegramBotToken ? "Saved" : "Not set" }),
    className: "mb-6",
    children: `
      <form method="POST" action="/settings/telegram" class="space-y-4">
        ${hiddenCsrf(csrfToken)}
        ${Input({
          name: "bot_token",
          type: "password",
          label: "Bot token",
          placeholder: "Leave blank to keep current token",
          appearance: "mono",
          autocomplete: "off",
          hint: telegramBotToken ? "A token is currently saved." : "No token saved yet.",
        })}
        <div class="flex justify-end">
          ${Button({ variant: "primary", children: "Save token" })}
        </div>
      </form>
    `,
  });

  const timezoneSection = Section({
    title: "Timezone",
    description: "Used for daily compaction and any system-level scheduling that should follow your local day.",
    className: "mb-6",
    children: `
      <form method="POST" action="/settings/timezone" class="space-y-4">
        ${hiddenCsrf(csrfToken)}
        ${Input({
          name: "timezone",
          label: "IANA timezone",
          value: timezone,
          placeholder: "Europe/Stockholm",
          appearance: "mono",
          hint: "Examples: <code class=\"text-zinc-300\">Europe/Stockholm</code>, <code class=\"text-zinc-300\">America/New_York</code>, <code class=\"text-zinc-300\">Asia/Tokyo</code>.",
        })}
        <div class="flex justify-end">
          ${Button({ variant: "primary", children: "Save timezone" })}
        </div>
      </form>
    `,
  });

  const aboutSection = Section({
    title: "About",
    children: `
      <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt class="text-zinc-500">Version</dt>
        <dd class="text-zinc-200 font-mono">${escapeHtml(steveVersion)}</dd>
      </dl>
    `,
  });

  return layout("Settings", `
    ${nav(csrfToken, "settings")}
    ${PageHeader({ title: "Settings", subtitle: "Global settings shared across all members." })}
    ${errorHtml}
    ${telegramSection}
    ${timezoneSection}
    ${aboutSection}
  `, { width: "app" });
}
