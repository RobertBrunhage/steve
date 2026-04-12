# Kellix Browser Architecture

This document defines the browser model Kellix is actually building now.

## Goals

- Keep the existing `container` browser as the stable default.
- Preserve per-user browser state, screenshots, and downloads.
- Support auth-heavy sites with a real, already-authenticated local Chrome session.
- Avoid building a custom host preview or takeover UI.
- Keep one Kellix-owned browser tool surface for agents.

## Product Shape

Kellix now has two browser targets:

- `container`
  - default
  - Playwright + Chromium inside the main `kellix` container
  - remote-viewable through the existing viewer URL
  - best for deterministic automation, screenshots, and normal browsing

- `remote`
  - auth-capable fallback
  - Kellix talks to a small host-side companion
  - the companion attaches to a real local Chrome session through Chrome DevTools MCP
  - no custom preview or takeover URL
  - best for sites that need a real browser environment or existing sign-in state

## What Changed

We are no longer investing in the old `host` model:

- no Kellix-managed host Chrome profiles
- no screenshot-polling host viewer
- no custom click/keyboard forwarding page

Instead, Kellix keeps the strong container path and adds a simpler attached-browser path.

## Remote Attach Model

The `remote` target means:

1. Kellix runs in Docker as usual.
2. A lightweight host-side remote browser companion runs outside Docker.
3. When Kellix needs the `remote` target, it calls that companion over HTTP.
4. The companion attaches to the operator's local Chrome session through Chrome DevTools MCP.
5. Kellix continues using the same top-level browser actions and snapshot loop.

This gives Kellix a real local browser without making the agent deal with raw CDP or custom Playwright code.

## Per-User Attachment

Attached browser access is per user, not global.

Each Kellix user can optionally have:

- an attached local Chrome session
- a preferred Chrome channel (`stable`, `beta`, `dev`, `canary`)
- last connected metadata

Container browsing is always on by default. The only system-level browser concern is whether the remote companion is available on this install.

## UX

### System settings

Dashboard settings do not need browser mode controls. Kellix always uses the container browser by default.

### User page

Each user page exposes:

- `Attach local Chrome`
- Chrome channel selection
- current attach status
- last connected timestamp
- `Detach`

The attach flow is:

1. Open the user page.
2. Attach local Chrome for that user.
3. On the host machine, run the remote browser companion.
4. In Chrome, enable remote debugging at `chrome://inspect/#remote-debugging`.
5. Keep Chrome running.
6. When Kellix needs the attached browser, Chrome shows the approval prompt.

## Auth Flow

The intended real-world flow is:

1. User asks Kellix to go to `x.com`.
2. Kellix starts in `container` by default.
3. If the site is auth-heavy or the container browser is rejected, Kellix escalates to `remote` when that user has an attached browser configured.
4. Kellix opens the page in the attached local Chrome session.
5. The user signs in or approves prompts in that real Chrome window.
6. The user says they are done.
7. Kellix continues using the attached browser state.

If a site only needs normal browsing, Kellix stays in `container` and can still return the container viewer URL.

## Browser Tool Contract

The agent-facing tools stay the same:

- `browser_open`
- `browser_snapshot`
- `browser_click`
- `browser_type`
- `browser_wait`
- `browser_screenshot`
- `browser_download`
- `send_file`

Targets are now:

```ts
export type BrowserTarget = "container" | "remote";
```

`viewerUrl` remains optional in results because only the container target currently returns one.

## Observation Model

The agent should still work from compact snapshots and element refs, not screenshots.

Example shape:

```json
{
  "ok": true,
  "status": "ok",
  "url": "https://example.com/account",
  "title": "Example Account",
  "text": "Welcome back. Orders. Account. Search...",
  "elements": [
    { "ref": "e1", "role": "textbox", "name": "Search" },
    { "ref": "e2", "role": "button", "name": "Sign in" }
  ]
}
```

For `remote`, Kellix maps Chrome DevTools MCP snapshot uids into the same Kellix browser ref flow.

## Backend Selection

Kellix, not the model, chooses the target.

Recommended behavior:

- default to `container`
- escalate to `remote` when:
  - the user explicitly asks for the attached browser
  - the domain is known to prefer a real browser (`x.com`, Google sign-in, Microsoft login, Amazon, etc.)
  - the container browser reports auth-required or browser-rejected state
- remember successful per-user domain preferences as `remote`

If the remote companion or attached browser is unavailable, Kellix should return a clear error when `remote` is explicitly required.

## Security Model

- `container` remains Kellix's isolated baseline browser.
- `remote` is higher-trust because it can act inside a real local Chrome session.
- attached browser access is per user
- there is no cross-user browser/session sharing
- browser artifacts remain per user
- remote companion access stays local/private to the Kellix install

Because `remote` can touch a real signed-in browser, it should remain an explicit user-level attachment, not a global default assumption.

## Current Implementation Direction

Solid baseline:

- container browser backend
- per-user container browser state and artifacts
- browser MCP/tool surface for agents
- container browser tests

Now being built:

- `remote` companion outside Docker
- per-user attach-local-Chrome configuration
- Chrome DevTools MCP attach flow for real local Chrome sessions
- auth escalation from `container` to `remote`

Not being pursued:

- old host-managed browser profiles
- host preview/takeover viewer
- screenshot-polling host control

## Success Criteria

Kellix should reliably do all of these:

- browse normally in the container browser and return a viewer URL when useful
- escalate to an attached local Chrome session for auth-heavy sites
- let the user complete sign-in in real Chrome
- continue using that authenticated browser state afterward
- keep the same top-level browser tools regardless of whether the active target is `container` or `remote`

That is the current target architecture.
