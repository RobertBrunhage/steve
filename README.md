<p align="center">
  <img src="assets/steve.gif" alt="Steve" width="220">
</p>

<p align="center">
  <strong>Your self-hosted household AI assistant.</strong><br>
  Autonomous, OpenCode-powered, secret-safe by default.
</p>

# Steve

Steve is a self-hosted household AI assistant you talk to on Telegram.

It can set up integrations, manage reminders, keep per-person memory, run recurring routines, and handle real workflows for your home - without asking you to paste API keys into chat.

If Steve needs credentials, it sends you straight to the right place in the dashboard. You add them there, Steve uses them securely, and the AI never sees the raw secret values.

Think OpenClaw-style autonomy, but simpler, more household-focused, and easier to trust.

## Why People Try Steve

- **It feels like an assistant, not a chatbot.** Steve can actually do things: run scripts, keep memory, manage schedules, and follow up later.
- **It is built for real people, not one power user.** Each person gets their own isolated agent, memory, skills, and integrations.
- **Secrets stay out of chat.** Steve handles setup through the dashboard and injects credentials into scripts only when needed.
- **You can teach it new capabilities with markdown.** Skills are plain folders with a `SKILL.md` and optional scripts.
- **It runs in your own environment.** Backups, restores, local hosting, and LAN access are all built in.

## What It Feels Like

```text
You: "connect my Withings scale"
Steve: "I need your app credentials - open this page"
You: add them in the dashboard
Steve: finishes setup, stores tokens securely, and keeps working
```

```text
You: "remind me every Monday to review my training"
Steve: creates the recurring job and follows up automatically
```

```text
You: "what was my weight trend this week?"
Steve: checks your memory + integrations and replies with context
```

## What You Get

- Telegram-based assistant UX
- Per-user isolated OpenCode containers
- Private user memory plus optional shared household files
- Dashboard for setup, integrations, jobs, and runtime control
- Encrypted vault for secrets
- Markdown-driven skills with script support
- Built-in backup and restore

## Install In A Minute

**Prerequisite:** Docker

```bash
curl -fsSL https://raw.githubusercontent.com/robertbrunhage/steve/main/install.sh | bash
```

That installs a local `steve` command, downloads the runtime into `~/.steve`, and starts Steve with the latest published release.

Useful commands:

```bash
steve logs
steve update
steve backup
steve restore <file>
```

First run:

1. Run the install command
2. Open the setup URL shown in the terminal
3. Create your dashboard password
4. Add your Telegram bot token
5. Create your first user
6. Open that user's page and connect Telegram
7. Start messaging Steve

If you need it again later, you can still run:

```bash
steve setup-url
```

Steve usually auto-detects a LAN-friendly URL like `http://<your-machine>.local:7838`.

If `.local` is flaky on your network, `http://localhost:7838` works too.

## What Makes Steve Different

### 1. Secrets Never Go Through Chat

When Steve needs credentials:

1. it notices what is missing
2. it links you to the right dashboard page
3. you add the credentials there
4. scripts receive only the exact fields they need at runtime

The AI orchestrates the workflow, but never handles the raw secret values.

### 2. Every User Gets Their Own Agent

Each user gets their own:

- OpenCode container
- workspace
- memory
- integrations
- skills

That means your household can share useful things like notes and lists without sharing private context by accident.

### 3. Skills Are Simple

A skill is just a directory like this:

```text
my-skill/
  SKILL.md
  scripts/
  templates/
```

`SKILL.md` holds both the instructions and the machine-readable frontmatter Steve needs. No SDK required.

### 4. It Is Actually Built To Live With You

Steve is not trying to be a public SaaS agent platform.

It is designed for trusted local or household use:

- LAN-friendly `.local` URLs
- one household admin dashboard
- backup/restore built in
- no need to expose it publicly

## How It Works

At a high level:

```text
You message Steve -> Steve picks the right user -> OpenCode does the work -> Steve replies
```

Under the hood, Steve handles:

- user routing
- integrations and secrets
- scheduled jobs and routines
- per-user workspaces and memory
- dashboard setup and control

Each user gets their own OpenCode container, their own workspace, and their own memory.

## Memory And Skills

Each user's workspace has structured long-term memory, for example:

```text
memory/
  profile.md
  schedule.md
  daily/
  training/
  nutrition/
  body-measurements/
```

Bundled skills can be synced into every user workspace with:

```bash
steve update skills
steve update skills --force
```

## Backup And Restore

- `steve backup` / `steve restore <file>` for the installed runtime
- `./steve backup` / `./steve restore <file>` for local development
- restore keeps users, workspaces, and secrets together

If needed after restore, Steve only asks you to finish dashboard password setup.

## Use Ollama

If you want to run Steve with a local model on your own machine, the simplest first version is to use Ollama.

1. Install and start Ollama on the host machine
2. Pull a model, for example:

```bash
ollama pull qwen3-coder:30b
```

3. Open a user's `Agent` page in Steve
4. In OpenCode, configure or select Ollama as the model provider
5. Use this base URL from the user container:

```text
http://host.docker.internal:11434/v1
```

That lets all user agents talk to the same Ollama instance running on your machine.

## Local Development

If you want to work on Steve itself:

```bash
git clone https://github.com/robertbrunhage/steve.git
cd steve
pnpm install
./steve up
```

There are two runtimes:

| Runtime | Command | Images | Default URL |
| --- | --- | --- | --- |
| Installed | `steve ...` | Published release images | `http://localhost:7838` |
| Local dev | `./steve ...` | Locally built images | `http://localhost:7839` |

So the mental model is simple:

- `steve ...` is your installed instance
- `./steve ...` is your development instance
- same commands, separate environments

Useful dev commands:

```bash
./steve build
./steve up
./steve logs
./steve update skills
./steve backup
./steve restore <file>
pnpm doctor
```

Published installs track versioned releases, not `latest`. `main` continues to publish dev images for trunk-based work.

If you want the newest main build anyway, use `steve update --yolo`.

## Security Model

Steve is designed for trusted local or household use.

- encrypted vault for secrets
- per-user isolation by default
- user integrations live on user pages
- system secrets live in Settings

## License

MIT
