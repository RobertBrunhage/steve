<p align="center">
  <img src="assets/steve.gif" alt="Steve" width="220">
</p>

<p align="center">
  <strong>Your autonomous household AI assistant.</strong><br>
  Telegram-first, OpenCode-powered, secret-safe by default.
</p>

# Steve

A fully autonomous household AI assistant you talk to on Telegram. Steve can set up integrations, manage schedules, coach your health, and run workflows for your household without you ever handing over an API key or password in chat.

You tell Steve what you need. If a skill requires credentials, Steve sends you a link to the web dashboard where you add them securely. The AI orchestrates everything but never sees your secrets.

Think OpenClaw-style autonomy, but with a household-first UX, per-user isolation, and a real secret vault.

```
You (Telegram) → Steve → OpenCode (per-user container) → tools, memory, skills → replies
```

## Why It Feels Different

- **Autonomous, not just a chatbot.** Steve reads your files, runs scripts, manages reminders, and connects to APIs — all from a Telegram message.
- **Zero-trust secrets.** The AI never sees your API keys. Credentials live in an encrypted vault. When a skill needs them, Steve injects them into scripts at runtime and strips them from output. If something needs setup, Steve sends you a link — you never paste secrets into chat.
- **Multi-user isolation.** Each person gets their own AI container with separate memory, sessions, context, and skills. Your household can share notes and lists without sharing private conversations.
- **Extensible with markdown.** Skills are just a folder with a `SKILL.md` (natural language instructions) and optional scripts. No SDK, no API — write what you want the AI to do in plain English.

## What Steve Can Do

- Talk to you in Telegram and keep working memory per person
- Set up integrations like Withings or anything else you teach it with skills
- Run reminders, check-ins, and recurring workflows
- Read and write files in each user's workspace
- Share household notes and lists while keeping user sessions isolated

## Quick Start

**Prerequisites:** Docker

```bash
curl -fsSL https://raw.githubusercontent.com/robertbrunhage/steve/main/install.sh | bash
```

That installs a local `steve` helper command, downloads the compose file into `~/.steve`, and starts the app.

```bash
steve setup-url  # Print the one-time setup URL
steve logs       # Follow logs
steve down       # Stop Steve
steve update     # Refresh compose and pull latest image
```

First run:

1. Start Steve
2. Open the one-time setup URL from `steve setup-url` or `steve logs`
3. Create your dashboard password
4. Add the Telegram bot token
5. Create your first user
6. Open that user page and connect Telegram

Steve auto-detects your machine name for LAN access and stores it as `STEVE_HOSTNAME`, so the dashboard will usually be at `http://<your-machine-name>.local:3000`.

If `.local` is flaky on your network, `http://localhost:3000` works too.

### From Source (for development)

```bash
git clone https://github.com/robertbrunhage/steve.git
cd steve
pnpm install
./steve up
```

Local development uses the same Docker Compose entrypoint as production. The only difference is image source and default port:

| Runtime | Command | Images | Default URL |
| --- | --- | --- | --- |
| Prod/install | `steve ...` | Published GHCR images | `http://localhost:3000` |
| Local/dev | `./steve ...` | Locally built images | `http://localhost:3001` |

So the mental model is simple:

- `steve ...` for an installed instance
- `./steve ...` inside this repo
- same verbs, same flow, separate runtimes

## Architecture

```
Docker Network
┌──────────────────────────────────────────────────┐
│                                                  │
│  steve (TS)               opencode-robert        │
│  ├ Telegram bot           ├ AI brain (isolated)  │
│  ├ MCP tools              └ per-user workspace   │
│  ├ Web dashboard (:3000)                         │
│  ├ Encrypted vault        opencode-vanessa       │
│  └ Scheduler              ├ AI brain (isolated)  │
│                           └ per-user workspace   │
│                                                  │
│  Volumes:                                        │
│  steve-vault ── keyfile + encrypted secrets      │
│  steve-data ─── users, shared                    │
└──────────────────────────────────────────────────┘
```

Each user gets a fully isolated OpenCode container with their own workspace, sessions, and AI context. Steve handles routing, scheduling, and secrets — the AI never touches the vault.

## First-Run UX

- Create one dashboard password
- Add the household Telegram bot token once
- Create users like `robert` or `vanessa`
- Link each user to their Telegram account on that user page
- Message the bot and let Steve do the rest

## Memory Structure

Each user's workspace has a `memory/` directory with persistent files and organized logs:

```
memory/
  profile.md             # Who they are, goals, preferences
  schedule.md            # Weekly plan
  daily/                 # Auto-generated session summaries
    2026-03-27.md
  training/              # Workout logs
    2026-03-27.md
  nutrition/             # Nutrition logs
    2026-03-27.md
  body-measurements/     # Measurement sessions
    2026-03-27.md
```

## Skills

A skill is a directory with instructions, optional scripts, and templates:

```
my-skill/
  SKILL.md       # Natural language instructions for the AI
  scripts/       # Shell scripts (credentials auto-injected)
  templates/     # File templates for consistent formats
```

Each user has their own `skills/` directory inside their workspace. Steve can copy bundled default skills into every user workspace and update them later with `steve update skills`. See `defaults/skills/TEMPLATE.md`.

## Secrets & Security

The AI is fully autonomous but never handles raw secrets. Here's how it works:

1. You ask Steve to set up an integration (e.g., "connect my Withings scale")
2. Steve checks if credentials exist. If not, it sends you to the right place in the web dashboard.
3. You add user-specific credentials on that user's page and system credentials in Settings — never in chat.
4. Steve's `run_script` tool injects them as env vars at runtime. Scripts that produce new credentials (e.g., OAuth tokens) use `save_to_vault` in their output — Steve saves them and strips the secrets before the AI sees anything.

Vault is AES-256-GCM encrypted. A keyfile auto-decrypts on startup — password only on first run.

## Backup And Restore

- `steve backup` / `steve restore <file>` work on the installed runtime
- `./steve backup` / `./steve restore <file>` work on the local dev runtime
- restored data keeps users, secrets, and workspaces; if needed, Steve only asks you to finish dashboard password setup

## Commands

```bash
steve up                 # Start Steve from published images
steve down               # Stop Steve
steve logs               # Follow logs
steve update             # Update to the newest published release
steve update skills      # Copy bundled skills to every user
steve update skills --force  # Overwrite bundled skills for every user
steve setup-url          # Print the one-time setup URL
steve backup             # Create encrypted backup
steve restore <file>     # Restore encrypted backup
```

For development:
```bash
./steve build            # Build local images
./steve up               # Start Steve locally
./steve logs             # Follow local logs
./steve update skills    # Copy bundled skills to every local user
./steve setup-url        # Print the local setup URL
./steve backup           # Create dev backup
./steve restore <file>   # Restore dev backup
pnpm launch              # Alias for ./steve up
pnpm backup              # Alias for ./steve backup
pnpm restore <file>      # Alias for ./steve restore
pnpm doctor              # Health check
```

Published installs track versioned releases, not `latest`. Each Steve release publishes matching `steve` and `steve-opencode` image tags, while `main` continues to publish dev images for trunk-based work.

## Current Deployment Model

Today Steve is designed for trusted local or household use:

- LAN-friendly `.local` URLs
- no HTTPS or reverse proxy by default
- one shared household admin password

It is already solid for personal use and private beta testing, but if you want to expose it publicly you should put it behind your own HTTPS/reverse-proxy setup.

## License

MIT
