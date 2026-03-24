# Steve

> *Named after the beloved monkey from Cloudy with a Chance of Meatballs - steeeeeeeve*

A personal Telegram assistant powered by the Claude CLI. No API keys needed - uses your local Claude installation.

~1,200 lines of TypeScript. File-based memory. Markdown skills. Auto-backup to GitHub.

```
You (Telegram) --> Steve --> Claude CLI --> reads/writes ~/.steve/ --> replies
```

## Quick start

**Prerequisites:** Node.js 22+, pnpm, [Claude CLI](https://docs.anthropic.com/en/docs/claude-code), git

```bash
git clone https://github.com/your-username/steve.git
cd steve
pnpm install
pnpm dev
```

First run walks you through setup interactively - Telegram bot token, user IDs, model choice, GitHub backup.

## What it does

- General-purpose assistant - ask anything
- Web search and URL reading
- Image processing (send photos on Telegram)
- Training coach with progression tracking
- Scheduled and one-off reminders
- Multi-user with isolated memory per person
- Shared household memory space
- Extensible with markdown skills + shell scripts
- OAuth via macOS Keychain (no plaintext credentials)

## How it works

Steve's code is just plumbing. The brain is `claude -p` with file tools scoped to `~/.steve/`. Skills are markdown files that tell Claude what to do. Memory is markdown files Claude reads and writes. Credentials are in the macOS Keychain.

Everything Claude needs to know (persona, skills, instructions) goes into the system prompt. Claude decides what files to read, what to remember, and when to use a skill.

```
steve/                          # The project
  src/                          # TypeScript plumbing
  defaults/                     # Copied to ~/.steve/ on first run
    SOUL.md                  # Default personality
    AGENTS.md                # Operating instructions
    skills/                     # Default skills
  scripts/credential.sh         # Keychain helper

~/.steve/                       # Your data (auto-synced to GitHub)
  config.json                   # Bot token, user IDs, model
  SOUL.md                    # Personality (edit anytime, no restart)
  AGENTS.md                  # Operating instructions (edit anytime)
  skills/                       # All skills (defaults + Steve-created)
  memory/
    {user}/                     # Per-user memories, reminders, logs
    shared/                     # Household-wide memories
```

## Skills

A skill is a directory with a `SKILL.md` and optional scripts:

```
my-skill/
  SKILL.md              # Frontmatter + natural language instructions
  scripts/              # Shell scripts Claude can run
  references/           # Extra docs Claude can read
```

Create skills by telling Steve (`"create a meal planning skill"`) or manually. See `~/.steve/skills/TEMPLATE.md` for the format.

Skills are global. Credentials are per-user (stored in macOS Keychain, not files).

## Steve vs OpenClaw

Steve is inspired by [OpenClaw](https://github.com/openclaw/openclaw) but takes a different approach.

| | Steve | OpenClaw |
|---|---|---|
| **Philosophy** | Minimal code, Claude does the work | Full-featured agent runtime |
| **Codebase** | ~1,200 lines | Massive monorepo |
| **Brain** | Spawns `claude -p` per message | Embedded agent runtime with streaming |
| **Skills** | Markdown + scripts (same pattern) | Markdown + scripts + registry + gating |
| **Memory** | File-based, Claude uses Glob/Grep | File-based + SQLite vector index |
| **Channels** | Telegram | 21+ (WhatsApp, Slack, Discord, etc.) |
| **Credentials** | macOS Keychain | SecretRef system (env, file, exec providers) |
| **Setup** | Interactive CLI, 2 minutes | More configuration required |
| **Backup** | Auto-sync to private GitHub repo | Manual |
| **Multi-agent** | Single agent | Multiple isolated agents |

**When to use Steve:** You want a simple, personal assistant you can set up in minutes and extend with markdown files. You're on a Mac, use Telegram, and have Claude CLI installed.

**When to use OpenClaw:** You need multi-channel support, multiple agents, a skill marketplace, or semantic memory search at scale.

## Security

- Credentials in macOS Keychain, not on disk
- Bash scoped to skill scripts only
- File access restricted to `~/.steve/`
- Telegram filtered by user ID
- Web search/fetch is read-only

## Development

```bash
pnpm dev          # Run Steve
pnpm test         # Run tests (uses temp dir, never touches ~/.steve/)
pnpm build        # TypeScript build
```

Set `STEVE_DIR` to override the data directory (used by tests and CI).

## License

MIT
