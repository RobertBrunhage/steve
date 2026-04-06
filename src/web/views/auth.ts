// Login, setup, and other auth-flow pages.

import {
  Button,
  Input,
  Section,
  escapeHtml,
  hiddenCsrf,
  inputClass,
  inputClassMono,
} from "../components.js";
import { flash, layout } from "./layout.js";

export function renderSetup(options: { needsVaultPassword: boolean; csrfToken: string; error?: string; authOnly?: boolean; timezone: string }): string {
  const { needsVaultPassword, csrfToken, error, authOnly, timezone } = options;
  const errorHtml = error ? flash(error, "error") : "";
  const passwordHelp = authOnly
    ? "Your restored data is already in place. Set the dashboard password to finish setup."
    : needsVaultPassword
    ? "This password protects your secrets and signs you into the dashboard."
    : "Choose your dashboard password. You can reuse your existing vault password.";

  const passwordSection = Section({
    title: "Step 1 — Create a password",
    description: `${passwordHelp} Steve stays unlocked after normal restarts.`,
    className: "mb-6",
    children: `
      <div class="space-y-3">
        <input type="password" name="password" placeholder="Password (8+ characters)" required minlength="8" autocomplete="new-password" class="${inputClassMono}">
        <input type="password" name="confirm_password" placeholder="Confirm password" required autocomplete="new-password" class="${inputClassMono}">
      </div>
    `,
  });

  const restSections = authOnly ? "" : `
    ${Section({
      title: "Step 2 — Confirm your timezone",
      description: "Steve uses this for daily compaction and system-level schedules. We auto-fill it from your browser when possible.",
      className: "mb-6",
      children: `
        <input type="text" id="timezone-input" name="timezone" value="${escapeHtml(timezone)}" placeholder="Europe/Stockholm" required class="${inputClassMono}">
      `,
    })}
    ${Section({
      title: "Step 3 — Set up Telegram",
      className: "mb-6",
      children: `
        <ol class="text-xs text-zinc-500 mb-4 space-y-1 list-decimal list-inside">
          <li>Open Telegram and message <strong class="text-zinc-300">@BotFather</strong></li>
          <li>Send <code class="text-blue-400">/newbot</code> and follow the prompts</li>
          <li>Copy the bot token and paste it below</li>
        </ol>
        <input type="text" name="bot_token" placeholder="123456789:ABCdef..." required autocomplete="off" class="${inputClassMono}">
      `,
    })}
    ${Section({
      title: "Step 4 — Create your first member",
      description: "Pick a name for yourself. After setup you'll connect Telegram on the member page. More members can be added later from the dashboard.",
      className: "mb-6",
      children: `
        <input type="text" name="user_name_0" placeholder="Robert" required class="${inputClass}">
      `,
    })}
  `;

  return layout("Setup", `
    <div class="text-center mb-8">
      <h1 class="text-2xl font-semibold text-white">Welcome to Steve</h1>
      <p class="text-sm text-zinc-500 mt-2">${authOnly ? "Your backup is restored. Finish dashboard setup to continue." : "Let's get you set up. This takes about 2 minutes."}</p>
    </div>
    ${errorHtml}
    <form method="POST" action="/setup">
      ${hiddenCsrf(csrfToken)}
      ${passwordSection}
      ${restSections}
      <div class="mt-2">
        ${Button({ variant: "primary", className: "w-full py-3", children: authOnly ? "Finish dashboard setup" : "Finish setup" })}
      </div>
    </form>
    <script>
      (function () {
        const input = document.getElementById('timezone-input');
        if (!input || input.value) return;
        try {
          const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          if (tz) input.value = tz;
        } catch {}
      })();
    </script>
  `, { width: "app" });
}

export function renderSetupComplete(nextUrl = "/", buttonLabel = "Go to dashboard"): string {
  return layout("Setup Complete", `
    <div class="text-center py-12">
      <div class="w-16 h-16 rounded-full bg-emerald-950 border border-emerald-800 flex items-center justify-center mx-auto mb-6">
        <span class="text-2xl text-emerald-400">&#10003;</span>
      </div>
      <h1 class="text-2xl font-semibold text-white mb-2">You're all set!</h1>
      <p class="text-sm text-zinc-400 mb-6">Next, open your member page and connect Telegram so Steve can reach you.</p>
      ${Button({ variant: "primary", href: nextUrl, children: buttonLabel })}
    </div>
  `, { width: "auth" });
}

export function renderLogin(error?: string): string {
  const errorHtml = error ? flash(error, "error") : "";
  return layout("Login", `
    <div class="text-center mb-8">
      <h1 class="text-2xl font-semibold text-white">Steve</h1>
      <p class="text-sm text-zinc-500 mt-2">Sign in with your dashboard password.</p>
    </div>
    ${errorHtml}
    ${Section({
      children: `
        <form method="POST" action="/login" class="space-y-5">
          ${Input({
            name: "password",
            type: "password",
            label: "Password",
            placeholder: "Dashboard password",
            required: true,
            autofocus: true,
            autocomplete: "current-password",
          })}
          ${Button({ variant: "primary", className: "w-full py-3", children: "Log in" })}
        </form>
      `,
    })}
  `, { width: "auth" });
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
  `, { width: "auth" });
}
