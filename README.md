# Steve

![steeeeeeeve](assets/steve.gif)

> *steeeeeeeve* - the monkey from Cloudy with a Chance of Meatballs, but now he can actually help you

A personal Telegram assistant powered by [OpenCode](https://github.com/opencode-ai/opencode). Supports OpenAI, Anthropic, local models - whatever OpenCode supports.

~1,080 lines of TypeScript. File-based memory. Markdown skills. Auto-backup to GitHub.

```
You (Telegram) --> Steve --> OpenCode --> reads/writes ~/.steve/ --> replies
```

## Quick start

**Prerequisites:** Node.js 22+, pnpm, [OpenCode](https://github.com/opencode-ai/opencode), git

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
- Multi-user with isolated memory and sessions per person
- Shared household memory space
- Extensible with markdown skills + shell scripts
- Credentials via macOS Keychain (no plaintext)

## How it works

Steve's code is just plumbing. The brain is OpenCode with file tools scoped to `~/.steve/`. OpenCode reads `SOUL.md` (personality) and `AGENTS.md` (operating instructions) directly, then discovers everything else on its own - reads skills when relevant, searches memory when needed, writes files when something's worth remembering. Each user gets their own persistent session.

```
steve/                          # The project
  src/                          # TypeScript plumbing
  defaults/                     # Copied to ~/.steve/ on first run
    SOUL.md                     # Personality
    AGENTS.md                   # Operating instructions
    skills/                     # Default skills
  scripts/credential.sh         # Keychain helper

~/.steve/                       # Your data (auto-synced to GitHub)
  config.json                   # Bot token, user IDs, model
  SOUL.md                       # Personality (edit anytime, no restart)
  AGENTS.md                     # Operating instructions (edit anytime)
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
  scripts/              # Shell scripts the agent can run
  references/           # Extra docs the agent can read
```

Create skills by telling Steve (`"create a meal planning skill"`) or manually. See `~/.steve/skills/TEMPLATE.md` for the format.

Skills are global. Credentials are per-user (stored in macOS Keychain, not files).

## Steve vs OpenClaw

Steve is inspired by [OpenClaw](https://github.com/openclaw/openclaw) but takes a radically simpler approach. Same skill format (SKILL.md + scripts), same file naming (SOUL.md, AGENTS.md), but Steve offloads almost everything to the agent runtime instead of building it in code.

| | Steve | OpenClaw |
|---|---|---|
| **Philosophy** | Minimal code, agent does the work | Full-featured agent runtime |
| **Codebase** | ~1,080 lines | Massive monorepo |
| **Brain** | OpenCode (any model/provider) | Embedded runtime, Anthropic-focused |
| **Models** | OpenAI, Anthropic, local - whatever OpenCode supports | Primarily Anthropic |
| **Prompt** | Lean - SOUL.md + AGENTS.md, agent discovers the rest | Bootstrap files + eligible skills + memory search results |
| **Sessions** | Per-user persistent sessions via OpenCode | Full session transcripts + compaction |
| **Skills** | Same format (SKILL.md + scripts) | Same format + registry + gating + hot-reload |
| **Memory** | File-based, agent uses Glob/Grep | File-based + SQLite vector index |
| **Channels** | Telegram | 21+ (WhatsApp, Slack, Discord, etc.) |
| **Credentials** | macOS Keychain | SecretRef system (env, file, exec providers) |
| **Setup** | Interactive CLI, 2 minutes | More configuration required |
| **Backup** | Auto-sync to private GitHub repo | Manual |

**When to use Steve:** You want a simple, model-agnostic personal assistant you can set up in minutes and extend with markdown files.

**When to use OpenClaw:** You need multi-channel support, multiple agents, a skill marketplace, or semantic memory search at scale.

## Security

- Credentials in macOS Keychain, not on disk
- File access scoped to `~/.steve/`
- Telegram filtered by user ID

## Development

```bash
pnpm dev          # Run Steve
pnpm test         # Run tests (uses temp dir, never touches ~/.steve/)
pnpm build        # TypeScript build
```

Set `STEVE_DIR` to override the data directory (used by tests and CI).

## License

MIT
