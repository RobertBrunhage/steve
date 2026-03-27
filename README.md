# Steve

A fully autonomous household AI assistant you talk to on Telegram. Steve can do things for you — set up integrations, manage schedules, coach your health — without you ever handing over an API key or password in chat.

You tell Steve what you need. If a skill requires credentials, Steve sends you a link to the web dashboard where you add them securely. The AI orchestrates everything but never sees your secrets.

```
You (Telegram) → Steve → OpenCode (per-user container) → tools, memory, skills → replies
```

## Why Steve

- **Autonomous, not just a chatbot.** Steve reads your files, runs scripts, manages reminders, and connects to APIs — all from a Telegram message.
- **Zero-trust secrets.** The AI never sees your API keys. Credentials live in an encrypted vault. When a skill needs them, Steve injects them into scripts at runtime and strips them from output. If something needs setup, Steve sends you a link — you never paste secrets into chat.
- **Multi-user isolation.** Each person gets their own AI container with separate memory, sessions, and context. Your household shares skills and grocery lists, not private conversations.
- **Extensible with markdown.** Skills are just a folder with a `SKILL.md` (natural language instructions) and optional scripts. No SDK, no API — write what you want the AI to do in plain English.

## Quick Start

**Prerequisites:** Docker

```bash
curl -fsSL https://raw.githubusercontent.com/robertbrunhage/steve/main/install.sh | bash
```

That installs a local `steve` helper command, downloads the compose file into `~/.steve`, and starts the app.

```bash
steve logs    # Follow logs
steve down    # Stop Steve
steve update  # Refresh compose and pull latest image
```

Open `http://<your-machine-name>.local:3000` — Steve auto-detects your machine name for LAN access and stores it as `STEVE_HOSTNAME`. On first boot, Steve prints a one-time setup link in the logs. That setup flow creates your household admin password, adds your Telegram bot token, and adds your first user. After setup, the dashboard requires that admin password.

### From Source (for development)

```bash
git clone https://github.com/robertbrunhage/steve.git
cd steve
pnpm install
pnpm launch
```

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
│  steve-data ─── users, skills, shared            │
└──────────────────────────────────────────────────┘
```

Each user gets a fully isolated OpenCode container with their own workspace, sessions, and AI context. Steve handles routing, scheduling, and secrets — the AI never touches the vault.

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

Skills are shared across all users. Create them by asking Steve or add them manually. See `skills/TEMPLATE.md`.

## Secrets & Security

The AI is fully autonomous but never handles raw secrets. Here's how it works:

1. You ask Steve to set up an integration (e.g., "connect my Withings scale")
2. Steve checks if credentials exist. If not, it sends you a link to the web dashboard.
3. You add the credentials there — never in chat.
4. Steve's `run_script` tool injects them as env vars at runtime. Scripts that produce new credentials (e.g., OAuth tokens) use `save_to_vault` in their output — Steve saves them and strips the secrets before the AI sees anything.

Vault is AES-256-GCM encrypted. A keyfile auto-decrypts on startup — password only on first run.

## Commands

```bash
docker compose up -d     # Start Steve
docker compose down      # Stop Steve
docker compose pull      # Update to latest
```

For development:
```bash
pnpm launch              # Build and start locally
pnpm backup              # Encrypted backup
pnpm restore <file>      # Restore from backup
pnpm doctor              # Health check
```

## License

MIT
