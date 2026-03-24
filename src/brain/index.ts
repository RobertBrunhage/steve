import { spawn, execSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { format } from "date-fns";
import matter from "gray-matter";
import { config } from "../config.js";

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

interface SkillMeta {
  name: string;
  description: string;
  per_user?: boolean;
  requires?: {
    bins?: string[];
    env?: string[];
  };
}

interface LoadedSkill {
  meta: SkillMeta;
  content: string;
  baseDir: string;
  available: boolean;
  missing: string[];
}

const MAX_HISTORY = 20;
const HISTORY_TTL_MS = 60 * 60 * 1000; // 1 hour

function loadPersona(): string {
  // Check ~/.steve/ first, then project root for default
  const userPersona = join(config.steveDir, "persona.md");
  const defaultPersona = join(config.defaultsDir, "persona.md");
  try {
    return readFileSync(existsSync(userPersona) ? userPersona : defaultPersona, "utf-8");
  } catch {
    return "You are Steve, a personal assistant. Be concise and helpful.";
  }
}

function checkBin(bin: string): boolean {
  try {
    execSync(`which ${bin}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function loadSkills(userName: string): LoadedSkill[] {
  const skills: LoadedSkill[] = [];

  let entries: string[];
  try {
    entries = readdirSync(config.skillsDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const skillDir = join(config.skillsDir, entry);

    // Skip non-directories and template
    if (entry === "TEMPLATE.md") continue;
    try {
      if (!statSync(skillDir).isDirectory()) continue;
    } catch {
      continue;
    }

    const skillFile = join(skillDir, "SKILL.md");
    try {
      const raw = readFileSync(skillFile, "utf-8");
      const { data, content } = matter(raw);

      const meta: SkillMeta = {
        name: data.name ?? entry,
        description: data.description ?? "",
        per_user: data.per_user ?? false,
        requires: data.requires,
      };

      // Check requirements
      const missing: string[] = [];

      if (meta.requires?.bins) {
        for (const bin of meta.requires.bins) {
          if (!checkBin(bin)) missing.push(`binary: ${bin}`);
        }
      }

      if (meta.requires?.env) {
        for (const envVar of meta.requires.env) {
          if (!process.env[envVar]) missing.push(`env: ${envVar}`);
        }
      }

      // Replace template variables
      const processed = content
        .replace(/\{baseDir\}/g, skillDir)
        .replace(/\{userName\}/g, userName);

      skills.push({
        meta,
        content: processed.trim(),
        baseDir: skillDir,
        available: missing.length === 0,
        missing,
      });
    } catch (err) {
      console.error(`[Skills] Failed to load ${entry}:`, err);
    }
  }

  return skills;
}

function buildSystemPrompt(
  userName: string,
  dataDir: string,
  history: ChatMessage[],
): string {
  const persona = loadPersona();
  const skills = loadSkills(userName);
  const dayInfo = format(new Date(), "EEEE, MMMM d, yyyy");

  let skillsSection = "";
  for (const skill of skills) {
    if (skill.available) {
      skillsSection += `\n### ${skill.meta.name}\n${skill.content}\n`;
    } else {
      skillsSection += `\n### ${skill.meta.name} (UNAVAILABLE)\nMissing requirements: ${skill.missing.join(", ")}. Tell the user what's needed if they try to use this skill.\n`;
    }
  }

  if (!skillsSection) {
    skillsSection = "\nNo skills defined yet.\n";
  }

  let prompt = `${persona}

Current date: ${dayInfo}
You are currently talking to **${userName}**.

## Your Data Directory
All your data lives in: ${dataDir}

- **This user's memories**: ${dataDir}/memory/${userName}/
- **Shared household memories**: ${dataDir}/memory/shared/
- **Skills**: ${dataDir}/skills/

You can read and write files using your tools (Read, Write, Edit, Glob, Grep).
You can run skill scripts via Bash (scoped to skill script directories only).

## How Memory Works
- When you learn something worth remembering, write a markdown file to the user's memory directory.
- Use YAML frontmatter with: name, type, description, date.
- Types: training_log, schedule, preference, note (or any type that makes sense).
- When you need context, search or read your memory files. Don't guess - look it up.
- Keep a MEMORY.md index file in the user's memory directory listing all memories.

## Skills
Skills are directories in ${dataDir}/skills/, each with a SKILL.md and optional scripts/ and references/ folders.
The user can ask you to create new skills. Use ${dataDir}/skills/TEMPLATE.md as reference for the format.

## Credentials
Credentials are stored securely in the macOS Keychain, NOT in plain files.

Use the credential helper script:
- **Check if credentials exist**: \`${config.projectRoot}/scripts/credential.sh has "${userName}" "{skill-name}"\`
- **Read credentials**: \`${config.projectRoot}/scripts/credential.sh get "${userName}" "{skill-name}"\` (outputs JSON)
- **Save credentials**: \`${config.projectRoot}/scripts/credential.sh set "${userName}" "{skill-name}" '{"key":"value"}'\`

Skills are global, credentials are per-user. When a skill needs auth, check with \`has\` first. If missing, walk the user through setup conversationally, then save with \`set\`.

### Active Skills
${skillsSection}

## General Behavior
- You are a general-purpose personal assistant first.
- Use your skills when relevant, but don't force them into every conversation.
- Before answering questions about the user's data, actually read the relevant files.
- Keep replies concise and mobile-friendly (this is used on Telegram and web).
- Use simple markdown: *bold* for emphasis, bullet points for lists.
`;

  if (history.length > 0) {
    prompt += `\n## Recent Conversation\n\n`;
    for (const msg of history) {
      const label = msg.role === "user" ? userName : "Steve";
      prompt += `**${label}:** ${msg.text}\n\n`;
    }
  }

  return prompt;
}

export class Brain {
  private history: Map<string, ChatMessage[]> = new Map();

  private getHistory(chatId: string): ChatMessage[] {
    const msgs = this.history.get(chatId) ?? [];
    const cutoff = Date.now() - HISTORY_TTL_MS;
    return msgs.filter((m) => m.timestamp > cutoff);
  }

  private addToHistory(chatId: string, role: "user" | "assistant", text: string) {
    const msgs = this.getHistory(chatId);
    msgs.push({ role, text, timestamp: Date.now() });
    this.history.set(chatId, msgs.slice(-MAX_HISTORY));
  }

  async think(
    userMessage: string,
    userName: string,
    chatId: string = "default",
  ): Promise<string> {
    try {
      const history = this.getHistory(chatId);
      const systemPrompt = buildSystemPrompt(userName, config.dataDir, history);
      const raw = await this.callClaude(userMessage, systemPrompt);
      const envelope = JSON.parse(raw);

      if (envelope.is_error) {
        console.error(`[Brain] Claude error:`, envelope.result);
        return "Sorry, I had trouble thinking about that. Try again?";
      }

      const cost = envelope.total_cost_usd ?? 0;
      const duration = envelope.duration_ms ?? 0;
      const numTurns = envelope.num_turns ?? 1;
      console.log(
        `[Brain] Cost: $${cost.toFixed(4)}, Duration: ${duration}ms, Turns: ${numTurns}, Model: ${envelope.model ?? "unknown"}`,
      );

      const reply = envelope.result || "I'm not sure what to say.";

      this.addToHistory(chatId, "user", userMessage);
      this.addToHistory(chatId, "assistant", reply);

      return reply;
    } catch (error) {
      console.error("[Brain] Error:", error);
      return "Something went wrong on my end. Give me a moment and try again.";
    }
  }

  private callClaude(userMessage: string, systemPrompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        "-p",
        "--output-format", "json",
        "--system-prompt", systemPrompt,
        "--model", config.claude.model,
        "--no-session-persistence",
        "--permission-mode", "bypassPermissions",
        "--add-dir", config.dataDir,
        "--allowedTools",
          "Read", "Write", "Edit", "Glob", "Grep",
          `Bash(${config.skillsDir}/*/scripts/*:*)`,
          `Bash(${config.projectRoot}/scripts/credential.sh:*)`,
      ];

      const proc = spawn("claude", args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: config.dataDir,
        timeout: 120_000,
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.stdin.write(userMessage);
      proc.stdin.end();

      proc.on("close", (code) => {
        if (code !== 0) {
          console.error(`[Brain] claude exited with code ${code}:`, stderr);
          reject(new Error(`claude exited with code ${code}: ${stderr}`));
          return;
        }
        resolve(stdout);
      });

      proc.on("error", (err) => {
        reject(err);
      });
    });
  }
}
