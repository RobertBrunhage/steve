# Steve

> *Named after the beloved monkey from Cloudy with a Chance of Meatballs - steeeeeeeve*

A personal assistant that runs on Telegram, powered by the Claude CLI. No API keys needed - it uses your local Claude installation.

Steve has file-based memory, modular skills defined in markdown, scheduled reminders, multi-user support, and encrypted credential storage. All your data lives in `~/.steve/` and auto-syncs to a private GitHub repo.

## How it works

You message Steve on Telegram. He reads your message, checks his memory and skills, thinks using Claude, and replies. If he needs to remember something, he writes it to a file. If he needs to check your training schedule, he reads it from a file. If a skill needs to call an API, he runs a script.

The entire brain is the Claude CLI (`claude -p`) with file tools. Steve's code is just plumbing - ~1,200 lines of TypeScript that connect Telegram to Claude and manage the data directory.

```
You (Telegram) --> Steve --> Claude CLI --> reads/writes ~/.steve/ --> replies
```

## Quick start

**Prerequisites:** Node.js 24+, pnpm, [Claude CLI](https://docs.anthropic.com/en/docs/claude-code), git

```bash
git clone https://github.com/your-username/steve.git
cd steve
pnpm install
pnpm dev
```

The first run walks you through setup:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Steve - Personal Assistant Setup
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Checking prerequisites...

  ✓ git found
  ✓ node found
  ✓ claude found
  ✓ GitHub CLI (gh) found

─── Telegram Bot ───

  1. Message @BotFather on Telegram, send /newbot
  2. Message @userinfobot to get your user ID

Bot token: ********
User ID(s): 12345,67890

─── Setting up ~/.steve/ ───

  ✓ Created directories
  ✓ Config saved
  ✓ Copied default skills
  ✓ Git repo initialized
  ✓ Private GitHub repo created and pushed

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Steve is ready!

  Data:   ~/.steve/
  Backup: Auto-syncs to GitHub every 5 min
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## What Steve can do

**Out of the box:**
- Chat about anything (he's a general-purpose assistant first)
- Track training schedules and log workouts with progression tracking
- Set recurring reminders (`"remind me every morning at 7am to work out"`)
- Set one-off reminders (`"remind me in 1 hour to check the laundry"`)
- Process images you send (food photos, progress pics, screenshots)
- Manage shared household info (grocery lists, joint plans)

**With additional skills:**
- Connect to APIs with OAuth (Withings, Google Calendar, etc.)
- Anything you can describe in a markdown file + a shell script

## Architecture

```
steve/                          # The project (installable)
  src/                          # ~1,200 lines of TypeScript
    index.ts                    # Entry point, setup, retry logic
    config.ts                   # Reads ~/.steve/config.json
    setup.ts                    # Interactive first-run setup
    sync.ts                     # Auto-commit to GitHub every 5 min
    scheduler.ts                # Cron + one-off reminder engine
    keychain.ts                 # macOS Keychain credential storage
    user-map.ts                 # Telegram user ID <-> name mapping
    bot/                        # Telegram handlers (grammY)
    brain/                      # Calls claude CLI, builds system prompt
  defaults/                     # Copied to ~/.steve/ on first run
    persona.md                  # Default personality
    skills/                     # Default skills
  scripts/credential.sh         # Keychain helper for skills

~/.steve/                       # Your data (auto-synced to GitHub)
  config.json                   # Bot token, user IDs, model
  persona.md                    # Your customized personality
  skills/                       # All skills (defaults + Steve-created)
  memory/
    Robert/                     # Per-user memories
      schedule.md
      profile.md
      training-log-2026-03-24.md
      reminders/
        morning-workout.md
    Vanessa/                    # Another user's memories
    shared/                     # Household-wide memories
  user-map.json
```

## Skills

Skills are directories in `~/.steve/skills/` with a `SKILL.md` and optional scripts:

```
weather/
  SKILL.md              # Instructions for Steve (markdown + frontmatter)
  scripts/
    fetch.sh            # API call wrapper
  references/
    api-docs.md         # Extra context Steve can read
```

### SKILL.md format

```yaml
---
name: Weather
description: Get weather forecasts for any location
per_user: true
requires:
  bins: [curl, jq]
---

## Weather Skill

### Setup
Check credentials: `scripts/credential.sh has "{userName}" "weather"`
If missing, ask the user for their API key and save it.

### Usage
When the user asks about weather, run:
`bash {baseDir}/scripts/fetch.sh ...`
```

Steve reads skill instructions and follows them. `{baseDir}` resolves to the skill's directory, `{userName}` to the current user. Skills can declare requirements that are checked at load time.

### Creating skills

Tell Steve: `"Create a skill for meal planning"` and he'll write the SKILL.md for you.

Or create one manually - see `~/.steve/skills/TEMPLATE.md` for the full reference.

## Reminders

Steve can create scheduled reminders that fire through the full AI flow:

**Recurring:** `"Remind me every weekday at 7am about my workout"`

Creates a file like `~/.steve/memory/Robert/reminders/morning-workout.md`:
```yaml
---
name: Morning workout
cron: "0 7 * * 1-5"
prompt: "Check my training schedule and tell me what to do today."
---
```

**One-off:** `"Remind me in 2 hours to call the dentist"`

Creates a file with an `at` timestamp that auto-deletes after firing.

When a reminder fires, Steve goes through his normal thinking process - reads your schedule, checks recent logs, and sends a contextual message. Not just a dumb notification.

## Multi-user

Each Telegram user gets their own memory directory. Memories, credentials, and reminders are isolated per person. There's also a shared memory space for household info.

Add user IDs to `~/.steve/config.json`:
```json
{
  "allowed_user_ids": [12345, 67890]
}
```

## Security

- **Credentials** stored in macOS Keychain, not plain files
- **Bash** scoped to only run scripts inside skill directories
- **File access** restricted to `~/.steve/` via `--add-dir`
- **Telegram** filtered by allowed user IDs
- **No web UI** - Telegram only

## Personality

Edit `~/.steve/persona.md` to change how Steve talks. Changes take effect on the next message - no restart needed.

## Backup

Steve auto-commits `~/.steve/` to a private GitHub repo every 5 minutes. Set up during first run if you have `gh` installed, or manually:

```bash
cd ~/.steve
gh repo create steve-data --private --source . --push
```

## Development

```bash
pnpm dev          # Run Steve
pnpm test         # Run setup integration tests
pnpm build        # TypeScript build
```

## License

MIT
