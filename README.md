# Kellix

Kellix is a self-hosted household AI assistant you talk to on Telegram.

It can set up integrations, manage reminders, keep per-person memory, run recurring routines, and handle real workflows for your home - without asking you to paste API keys into chat.

If Kellix needs credentials, it sends you straight to the right place in the dashboard. You add them there, Kellix uses them securely, and the AI never sees the raw secret values.

Think OpenClaw-style autonomy, but simpler, more household-focused, and easier to trust.

## Why Kellix

- **It feels like an assistant, not a chatbot.** Kellix can do things: run scripts, keep memory, manage schedules, and follow up later, or even browse the web.
- **It is built for real people, not one power user.** Each person gets their own isolated agent, memory, skills, and integrations.
- **Secrets stay out of chat.** Kellix handles setup through the dashboard and injects credentials into scripts only when needed. Your AI provider never sees your secrets.
- **You can teach it new capabilities with markdown.** Skills are plain folders with a `SKILL.md` and optional scripts.
- **It runs in your own environment.** Backups, restores, local hosting, and LAN access are all built in.

## What It Feels Like

```text
You: "connect my Withings scale"
Kellix: "I need your app credentials - open this page"
You: add them in the dashboard
Kellix: finishes setup, stores tokens securely, and keeps working
```

```text
You: "remind me every Monday to review my training"
Kellix: creates the recurring job and follows up automatically
```

```text
You: "what was my weight trend this week?"
Kellix: checks your memory + integrations and replies with context
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
curl -fsSL https://raw.githubusercontent.com/robertbrunhage/kellix/main/install.sh | bash
```

That installs a local `kellix` command, downloads the runtime into `~/.kellix`, and starts Kellix with the latest published release.

Useful commands:

```bash
kellix logs
kellix update
kellix backup
kellix restore <file>
```

First run:

1. Run the install command
2. Open the setup URL shown in the terminal
3. Create your dashboard password
4. Add your Telegram bot token
5. Create your first user
6. Open that user's page and connect Telegram
7. Start messaging Kellix

If you need it again later, you can still run:

```bash
kellix setup-url
```

Kellix usually auto-detects a LAN-friendly URL like `http://<your-machine>.local:7838`.

If `.local` is flaky on your network, `http://localhost:7838` works too.

## What Makes Kellix Different

### 1. Secrets Never Go Through Chat

When Kellix needs credentials:

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

`SKILL.md` holds both the instructions and the machine-readable frontmatter Kellix needs. No SDK required.

### 4. It Is Actually Built To Live With You

Kellix is not trying to be a public SaaS agent platform.

It is designed for trusted local or household use:

- LAN-friendly `.local` URLs
- one household admin dashboard
- backup/restore built in
- no need to expose it publicly

## How It Works

At a high level:

```text
You message Kellix -> Kellix picks the right user -> OpenCode does the work -> Kellix replies
```

Under the hood, Kellix handles:

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
kellix update skills
kellix update skills --force
```

## Backup And Restore

- `kellix backup` / `kellix restore <file>` for the installed runtime
- `./kellix backup` / `./kellix restore <file>` for local development
- restore keeps users, workspaces, and secrets together

If needed after restore, Kellix only asks you to finish dashboard password setup.

## Use Ollama

If you want to run Kellix with a local model on your own machine, the simplest first version is to use Ollama.

1. Install and start Ollama on the host machine
2. Pull a model, for example:

```bash
ollama pull qwen3-coder:30b
```

3. Open a user's `Agent` page in Kellix
4. In OpenCode, configure or select Ollama as the model provider
5. Use this base URL from the user container:

```text
http://host.docker.internal:11434/v1
```

That lets all user agents talk to the same Ollama instance running on your machine.

## Local Development

If you want to work on Kellix itself:

```bash
git clone https://github.com/robertbrunhage/kellix.git
cd kellix
pnpm install
./kellix up
```

There are two runtimes:

| Runtime | Command | Images | Default URL |
| --- | --- | --- | --- |
| Installed | `kellix ...` | Published release images | `http://localhost:7838` |
| Local dev | `./kellix ...` | Locally built images | `http://localhost:7839` |

So the mental model is simple:

- `kellix ...` is your installed instance
- `./kellix ...` is your development instance
- same commands, separate environments

Useful dev commands:

```bash
./kellix build
./kellix up
./kellix logs
./kellix update skills
./kellix backup
./kellix restore <file>
pnpm doctor
```

Published installs track versioned releases, not `latest`. `main` continues to publish dev images for trunk-based work.

If you want the newest main build anyway, use `kellix update --yolo`.

## Security Model

Kellix is designed for trusted local or household use.

- encrypted vault for secrets
- per-user isolation by default
- user integrations live on user pages
- system secrets live in Settings

## License

MIT
