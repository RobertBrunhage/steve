# Steve

A personal Telegram assistant powered by [OpenCode](https://github.com/opencode-ai/opencode). Two Docker containers, zero-trust secrets, extensible with markdown skills.

```
You (Telegram) --> Steve --> OpenCode --> reads/writes your data --> replies via MCP
```

## Quick Start

**Prerequisites:** Docker, Node.js, pnpm

```bash
git clone https://github.com/your-username/steve.git
cd steve
pnpm install
pnpm launch
```

First run walks you through:
1. Set a vault password
2. OpenCode auth (log in to your AI provider)
3. Add your Telegram bot token and users (via web UI at :3000)
4. Done. Message your bot on Telegram.

Subsequent runs: `pnpm launch`, enter vault password, everything starts.

## Architecture

```
Docker Network (private)
┌──────────────────────────────────────────┐
│                                          │
│  steve (TS)            opencode (serve)  │
│  - Telegram bot        - AI brain        │
│  - MCP server (HTTP)   - bash, read,     │
│  - Web UI (:3000)        write, glob     │
│  - Encrypted vault     - HTTP API        │
│  - Scheduler                             │
│                                          │
│  /vault (secrets)      /data (shared)    │
│  steve-only            ~/.steve/         │
└──────────────────────────────────────────┘
```

- **steve container**: Telegram bot, MCP server, secret vault, web UI, scheduler
- **opencode container**: AI brain with `opencode serve`, sandboxed bash
- **~/.steve/**: Your data (memory, skills, personality). Bind-mounted, git-syncable.
- **vault volume**: Encrypted secrets. Steve-only, never git-synced.

## What It Does

- General-purpose assistant via Telegram
- Web search and URL reading
- Image understanding (send photos)
- Health coaching: training, nutrition, body composition, goal tracking
- Scheduled and one-off reminders
- Multi-user with isolated memory per person
- Shared household memory
- Extensible with markdown skills + shell scripts
- Zero-trust secrets: AI never sees your API keys

## How It Works

Steve's code is plumbing. The brain is OpenCode running in a sandboxed container. It reads `SOUL.md` (personality) and `AGENTS.md` (instructions) from your data directory, discovers skills when relevant, reads/writes memory files, and responds via the `send_telegram_message` MCP tool.

The AI never sees your secrets. When a skill needs credentials (e.g., Withings API), the MCP `run_script` tool injects them as environment variables from the encrypted vault. The script output goes back to the AI, not the credentials.

## Data Directory

`~/.steve/` is pure user data. No logic, no secrets, no config.

```
~/.steve/
  SOUL.md                     # Personality (edit anytime)
  AGENTS.md                   # Operating instructions (edit anytime)
  skills/                     # Skills (synced from defaults on boot)
    training-coach/SKILL.md
    training-coach/templates/   # File templates for consistent formats
    reminders/SKILL.md
    withings/SKILL.md
  memory/
    {user}/                   # Per-user memories, logs, schedules
    shared/                   # Household-wide memories
```

Runtime config (`opencode.json`, `.opencode/`, `config.json`) is generated on every boot and gitignored.

## Skills

A skill is a directory with a `SKILL.md`, optional scripts, and optional templates:

```
my-skill/
  SKILL.md              # Frontmatter + natural language instructions
  scripts/              # Shell scripts (credentials auto-injected)
  templates/            # File templates for consistent data formats
```

Create skills by asking Steve ("create a meal planning skill") or manually. See `skills/TEMPLATE.md`.

## Secrets

All secrets live in an encrypted vault (AES-256-GCM). Manage them at `http://localhost:3000`.

- Vault password is the only thing you need to remember
- Bot token, API keys, OAuth tokens all stored in the vault
- Web UI for adding/editing/deleting secrets
- Scripts get credentials injected as `STEVE_CRED_*` env vars
- The AI never sees raw credentials

## Adding Integrations

1. Message Steve: "add Home Assistant integration"
2. Steve creates a skill with instructions
3. Steve tells you: "Add your API key at http://localhost:3000/secrets"
4. You paste the key in the web UI
5. Done. Steve can now use the integration.

## Security

- AI runs in a sandboxed Docker container
- Secrets encrypted at rest, injected only into script subprocesses
- Telegram filtered by user ID allowlist
- MCP tools are the only way the AI interacts with the outside world
- Scripts snapshotted at startup (AI can't create and execute new scripts)

## Development

```bash
pnpm launch           # Start with Docker (recommended)
pnpm dev              # Run locally without Docker (requires opencode installed)
pnpm build            # TypeScript build
pnpm test             # Run tests
```

## License

MIT
