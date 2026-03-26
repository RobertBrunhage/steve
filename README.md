# Steve

A personal assistant powered by [OpenCode](https://github.com/opencode-ai/opencode). Per-user Docker containers, encrypted vault, extensible with markdown skills.

```
You (Telegram) --> Steve --> OpenCode (per-user) --> reads/writes data --> replies via MCP
```

## Quick Start

**Prerequisites:** Docker, Node.js, pnpm

```bash
git clone https://github.com/your-username/steve.git
cd steve
pnpm install
pnpm launch
```

First run:
1. Create a password (protects your encrypted vault)
2. Open the web UI at `:3000` — add your Telegram bot token and yourself
3. Go to the dashboard, click your name, click "Start Agent"
4. In the OpenCode UI, connect your AI provider
5. Message your bot on Telegram

Subsequent runs: `pnpm launch` — no password needed (keyfile auto-decrypts).

## Architecture

```
Docker Network (private)
┌─────────────────────────────────────────────────┐
│                                                 │
│  steve (TS)              opencode-robert        │
│  - Telegram bot          - AI brain (isolated)  │
│  - MCP server            - per-user workspace   │
│  - Web dashboard (:3000)                        │
│  - Encrypted vault       opencode-vanessa       │
│  - Scheduler             - AI brain (isolated)  │
│                          - per-user workspace   │
│                                                 │
│  steve-vault (volume)    steve-data (volume)    │
│  keyfile + secrets       users, skills, shared  │
└─────────────────────────────────────────────────┘
```

- **Steve container**: Telegram bot, MCP server, vault, web dashboard, scheduler
- **OpenCode containers**: One per user, isolated workspaces, started from dashboard
- **steve-data volume**: User workspaces, shared skills, shared household data
- **steve-vault volume**: Encrypted secrets + keyfile (Steve-only, never exposed to AI)

## What It Does

- General-purpose assistant via Telegram
- Web search and URL reading
- Image understanding (send photos)
- Health coaching: training, nutrition, body composition, goal tracking
- Scheduled and one-off reminders
- Multi-user with fully isolated containers per person
- Shared skills and household memory
- Extensible with markdown skills + shell scripts
- Zero-trust secrets: AI never sees your API keys

## How It Works

Steve is plumbing. The brain is OpenCode running in per-user sandboxed containers. Each user's OpenCode reads `SOUL.md` (personality) and `AGENTS.md` (instructions), discovers skills, reads/writes memory files, and responds via the `send_message` MCP tool.

The AI never sees your secrets. When a skill needs credentials, the MCP `run_script` tool injects them as environment variables. Scripts that produce credentials use the `save_to_vault` convention — Steve strips the secrets from the output before the AI sees it.

## Data

All data lives in Docker named volumes (no host bind mounts):

```
steve-data volume:
  users/
    robert/              # Robert's workspace (OpenCode working dir)
      SOUL.md
      AGENTS.md
      memory/            # Memories, logs, schedules
    vanessa/             # Vanessa's workspace (same structure)
  skills/                # Shared skills (all users)
  shared/                # Shared household data
```

## Skills

A skill is a directory with a `SKILL.md`, optional scripts, and optional templates:

```
my-skill/
  SKILL.md              # Frontmatter + natural language instructions
  scripts/              # Shell scripts (credentials auto-injected)
  templates/            # File templates for consistent data formats
```

Skills are shared across all users. Create skills by asking Steve or manually. See `skills/TEMPLATE.md`.

## Secrets

All secrets live in an encrypted vault (AES-256-GCM + keyfile). Manage them at the web dashboard.

- Keyfile auto-decrypts on startup (no password needed daily)
- Password only for first run and backup/restore
- Bot token, API keys, OAuth tokens all in the vault
- Scripts get credentials via `STEVE_CRED_*` env vars
- Scripts save credentials via `save_to_vault` (stripped before AI sees output)
- The AI has no access to the vault volume

## Backup & Restore

```bash
pnpm backup              # Encrypt all data to steve-backup-YYYY-MM-DD.enc
pnpm restore <file>      # Decrypt and restore from backup
```

## Commands

```bash
pnpm launch              # Start Steve (Docker)
pnpm backup              # Create encrypted backup
pnpm restore <file>      # Restore from backup
pnpm doctor              # Check system health
pnpm build               # TypeScript build
```

## License

MIT
