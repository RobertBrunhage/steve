<p align="left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" alt="Kellix" width="72" height="72" />
  </picture>
</p>

# Kellix

> An AI assistant for your everyday.

A self-hosted AI assistant that actually does things. You talk to it on Telegram. Track food, coach workouts, browse the web, build integrations. One for every person in your house.

---

## Install

Docker is the only prerequisite.

```bash
curl -fsSL https://raw.githubusercontent.com/robertbrunhage/kellix/main/install.sh | bash
```

That installs a local `kellix` command, downloads the runtime into `~/.kellix`, and starts the latest published release.

**First run:**

1. Run the install command
2. Open the setup URL shown in the terminal
3. Create your dashboard password
4. Add your Telegram bot token
5. Create your first person
6. Open that person's page and connect Telegram
7. Start messaging Kellix

Kellix usually auto-detects a LAN-friendly URL like `http://<your-machine>.local:7838`. If `.local` is flaky on your network, `http://localhost:7838` works too.

Lost the setup link? Run `kellix setup-url`.

---

## What it feels like

```
You: Remind me to call mom at 5
Kellix: Done. I'll ping you at 5pm.
```

```
You: [photo of lunch]
You: Log this
Kellix: Black bean bowl. 520 kcal logged.
```

```
You: What did I eat today?
Kellix: 1,840 kcal so far. 124g protein. You're on track.
```

```
You: Can you build me an integration that pulls my Goodreads reading list?
Kellix: Done. I created a new skill that fetches your shelf via their RSS feed.
        Want me to check it weekly and update your reading log?
```

---

## What makes it different

**Every person gets their own assistant.** Private memory, private integrations, private conversations. Each person runs in their own isolated OpenCode container. Share household files when you want to, not by accident.

**Secrets never go through chat.** When Kellix needs credentials, it links you to the dashboard. You add them there. Scripts receive only the exact fields they need at runtime. The AI orchestrates the workflow but never sees the raw values.

**Skills are just markdown.** A skill is a folder with a `SKILL.md` and optional scripts. No SDK, no framework. Describe what it should do and Kellix uses it.

**It has its own browser.** Each assistant comes with a built-in browser for looking things up, filling forms, and taking screenshots. Power users can attach their own Chrome for full remote control.

**Runs in your environment.** One Docker command, your own machine, LAN-friendly URLs. Backups and restores are built in. No cloud account needed.

---

## Under the hood

**Any AI provider or your own.** OpenAI, Google, or any OpenAI-compatible API. Run Ollama locally and your data never leaves your network. Switch providers per person or for the whole household.

**Built on OpenCode.** Each person runs in their own OpenCode container with their own workspace, memory, and tools. Nothing leaks between users.

**Encrypted vault.** Credentials are stored encrypted at rest and injected at runtime. The AI orchestrates workflows but never handles raw values.

**Open source.** MIT licensed. Read the code, fork it, extend it. No cloud dependency, no vendor lock-in.

---

## Architecture

```
You message Kellix → Kellix picks the right person → OpenCode does the work → Kellix replies
```

Under the hood, Kellix handles:

- user routing
- integrations and secrets
- scheduled jobs and routines
- per-user workspaces and memory
- dashboard setup and control

Each person's workspace has structured long-term memory:

```
memory/
  profile.md
  schedule.md
  daily/
  training/
  nutrition/
  body-measurements/
```

Bundled skills can be synced into every person's workspace:

```bash
kellix update skills
kellix update skills --force
```

---

## Useful commands

```bash
kellix logs         # stream logs
kellix update       # update to the latest release
kellix update opencode # pull the latest OpenCode image and recreate agents
kellix backup       # encrypted backup of users, workspaces, and secrets
kellix restore <file>
kellix setup-url    # print the dashboard setup link
```

---

## Use a local model (Ollama)

Want Kellix fully offline? Point it at Ollama.

1. Install and start Ollama on the host machine
2. Pull a model, for example:

   ```bash
   ollama pull qwen3-coder:30b
   ```

3. Open a person's `Agent` page in Kellix
4. In OpenCode, configure or select Ollama as the model provider
5. Use this base URL from inside the user container:

   ```
   http://host.docker.internal:11434/v1
   ```

All user agents will talk to the same Ollama instance running on your machine.

---

## Backup and restore

- `kellix backup` / `kellix restore <file>` for the installed runtime
- `./kellix backup` / `./kellix restore <file>` for local development

Restores keep users, workspaces, and secrets together. After a restore, Kellix only asks you to finish dashboard password setup.

---

## Security model

Kellix is built for trusted local or household use.

- encrypted vault for secrets
- per-user isolation by default
- user integrations live on each person's page
- system secrets live in Settings

---

## Local development

Want to work on Kellix itself?

```bash
git clone https://github.com/robertbrunhage/kellix.git
cd kellix
pnpm install
./kellix up
```

Two runtimes coexist:

| Runtime  | Command       | Images                   | Default URL             |
| -------- | ------------- | ------------------------ | ----------------------- |
| Installed | `kellix ...`  | Published release images | `http://localhost:7838` |
| Local dev | `./kellix ...` | Locally built images     | `http://localhost:7839` |

Mental model:

- `kellix ...` is your installed instance
- `./kellix ...` is your development instance
- same commands, separate environments

Dev commands:

```bash
./kellix build
./kellix up
./kellix logs
./kellix update skills
./kellix backup
./kellix restore <file>
pnpm doctor
```

Published installs pin the Kellix app image to versioned releases, while the OpenCode runtime tracks the rolling `kellix-opencode:main` image. Use `kellix update opencode` or the dashboard's Agent tab to pull newer OpenCode without a Kellix release. Want the newest Kellix `main` build anyway? Use `kellix update --yolo`.

---

## License

MIT
