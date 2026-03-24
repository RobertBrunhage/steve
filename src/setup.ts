import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  cpSync,
} from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import * as p from "@clack/prompts";
import { steveDir, configPath, config } from "./config.js";

// --- Helpers ---

function checkCommand(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isGhAuthenticated(): boolean {
  try {
    execSync("gh auth status", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function hasGitRemote(): boolean {
  try {
    execSync("git remote get-url origin", { cwd: steveDir, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// --- Setup steps ---

function createDirectories() {
  mkdirSync(steveDir, { recursive: true });
  mkdirSync(config.memoryDir, { recursive: true });
  mkdirSync(join(config.memoryDir, "shared"), { recursive: true });
}

function copyDefaults() {
  const copied: string[] = [];

  // Copy markdown files from defaults/
  for (const file of ["SOUL.md", "AGENTS.md"]) {
    const src = join(config.defaultsDir, file);
    const dest = join(steveDir, file);
    if (existsSync(src) && !existsSync(dest)) {
      cpSync(src, dest);
      copied.push(file);
    }
  }

  // Skills
  const src = config.defaultSkillsDir;
  const dest = config.skillsDir;
  mkdirSync(dest, { recursive: true });

  if (existsSync(src)) {
    for (const entry of readdirSync(src)) {
      const destEntry = join(dest, entry);
      if (!existsSync(destEntry)) {
        cpSync(join(src, entry), destEntry, { recursive: true });
        copied.push(entry);
      }
    }
  }

  return copied;
}

function saveConfig(botToken: string, users: Record<string, string>, model: string) {
  writeFileSync(
    configPath,
    JSON.stringify(
      { telegram_bot_token: botToken, users, model },
      null,
      2,
    ),
    "utf-8",
  );
}

function initGitRepo(): boolean {
  if (existsSync(join(steveDir, ".git"))) return true;

  try {
    execSync("git init", { cwd: steveDir, stdio: "ignore" });
    writeFileSync(join(steveDir, ".gitignore"), "tmp/\n", "utf-8");
    execSync('git add -A && git commit -m "Initial Steve data"', {
      cwd: steveDir,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function createGitHubRepo(): "created" | "exists" | "skipped" | "failed" {
  if (hasGitRemote()) return "exists";
  if (!checkCommand("gh")) return "skipped";
  if (!isGhAuthenticated()) return "skipped";

  try {
    execSync(
      'gh repo create steve-data --private --source . --push --description "Steve personal assistant data"',
      { cwd: steveDir, stdio: ["pipe", "pipe", "pipe"] },
    );
    return "created";
  } catch (err: any) {
    if (err.stderr?.toString().includes("already exists")) {
      try {
        const username = execSync("gh api user -q .login", {
          encoding: "utf-8",
        }).trim();
        execSync(
          `git remote add origin https://github.com/${username}/steve-data.git`,
          { cwd: steveDir, stdio: "ignore" },
        );
        execSync("git push -u origin main", {
          cwd: steveDir,
          stdio: "ignore",
        });
        return "exists";
      } catch {
        return "failed";
      }
    }
    return "failed";
  }
}

// --- Main flow ---

async function fullSetup(): Promise<boolean> {
  p.intro("Steve - Personal Assistant");

  // Step 1: Prerequisites
  const prereqs = p.group(
    {
      check: () => {
        const results: { name: string; ok: boolean; hint?: string }[] = [
          { name: "git", ok: checkCommand("git"), hint: "brew install git" },
          { name: "node", ok: checkCommand("node"), hint: "brew install node" },
          {
            name: "claude",
            ok: checkCommand("claude"),
            hint: "https://docs.anthropic.com/en/docs/claude-code",
          },
        ];

        const ghOk = checkCommand("gh");
        const ghAuth = ghOk && isGhAuthenticated();

        const missing = results.filter((r) => !r.ok);
        if (missing.length > 0) {
          const msg = missing
            .map((m) => `${m.name} - install with: ${m.hint}`)
            .join("\n  ");
          return Promise.reject(
            new Error(`Missing required tools:\n  ${msg}`),
          );
        }

        const status = results.map((r) => r.name).join("  ");
        const ghStatus = ghOk
          ? ghAuth
            ? "  gh (authenticated)"
            : "  gh (not authenticated - run: gh auth login)"
          : "";

        p.log.success(`${status}${ghStatus}`);
        return Promise.resolve(true);
      },
    },
    {
      onCancel: () => {
        p.cancel("Setup cancelled.");
        process.exit(0);
      },
    },
  );

  await prereqs;

  // Step 2: Telegram
  p.log.step("Telegram setup");
  p.log.message(
    "You need a bot token and your user ID.\n" +
      "  1. Message @BotFather on Telegram, send /newbot\n" +
      "  2. Message @userinfobot to get your user ID",
  );

  const botToken = await p.text({
    message: "Bot token",
    placeholder: "paste from @BotFather",
    validate: (v) => (!v || v.length < 10 ? "That doesn't look right" : undefined),
  });

  if (p.isCancel(botToken)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  // Collect users one at a time
  const users: Record<string, string> = {};
  let addMore = true;

  while (addMore) {
    const name = await p.text({
      message: "User name",
      placeholder: "e.g. Robert",
      validate: (v) => (!v ? "Name is required" : undefined),
    });
    if (p.isCancel(name)) { p.cancel("Setup cancelled."); process.exit(0); }

    const id = await p.text({
      message: `Telegram user ID for ${name}`,
      placeholder: "get it from @userinfobot",
      validate: (v) => (!v || isNaN(Number(v)) ? "Must be a number" : undefined),
    });
    if (p.isCancel(id)) { p.cancel("Setup cancelled."); process.exit(0); }

    users[id as string] = name as string;

    const more = await p.confirm({ message: "Add another user?" });
    if (p.isCancel(more)) { p.cancel("Setup cancelled."); process.exit(0); }
    addMore = more;
  }

  if (Object.keys(users).length === 0) {
    p.log.error("At least one user is required.");
    process.exit(1);
  }

  // Step 3: Model
  const model = await p.select({
    message: "Claude model",
    options: [
      { value: "sonnet", label: "Sonnet", hint: "fast, good for most things" },
      {
        value: "opus",
        label: "Opus",
        hint: "smartest, slower",
      },
      { value: "haiku", label: "Haiku", hint: "fastest, simplest tasks" },
    ],
  });

  if (p.isCancel(model)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  // Step 4: Create everything
  const s = p.spinner();

  s.start("Creating ~/.steve/");
  createDirectories();
  saveConfig(botToken as string, users, model as string);
  const copied = copyDefaults();
  s.stop("Created ~/.steve/");

  if (copied.length > 0) {
    p.log.success(`Copied defaults: ${copied.join(", ")}`);
  }

  // Step 5: Git + GitHub
  s.start("Initializing git repo");
  const gitOk = initGitRepo();
  s.stop(gitOk ? "Git repo ready" : "Git init failed (non-critical)");

  if (gitOk) {
    s.start("Setting up GitHub backup");
    const ghResult = createGitHubRepo();
    switch (ghResult) {
      case "created":
        s.stop("Private GitHub repo created");
        break;
      case "exists":
        s.stop("GitHub remote connected");
        break;
      case "skipped":
        s.stop("GitHub backup skipped (gh not available or not authenticated)");
        p.log.info(
          "Set up later: cd ~/.steve && gh repo create steve-data --private --source . --push",
        );
        break;
      case "failed":
        s.stop("GitHub setup failed (non-critical)");
        p.log.info("Set up manually later");
        break;
    }
  }

  // Done
  p.log.success("Data:   ~/.steve/");
  p.log.success("Config: ~/.steve/config.json");
  if (hasGitRemote()) {
    p.log.success("Backup: Auto-syncs to GitHub every 5 min");
  }

  p.outro("Steve is ready!");
  return true;
}

export async function runSetup(): Promise<boolean> {
  // Already configured - ensure directories and defaults exist
  if (existsSync(configPath)) {
    try {
      const existing = JSON.parse(readFileSync(configPath, "utf-8"));
      if (existing.telegram_bot_token) {
        createDirectories();
        copyDefaults();
        initGitRepo();
        return true;
      }
    } catch {
      // Corrupt config, fall through to full setup
    }
  }

  return fullSetup();
}
