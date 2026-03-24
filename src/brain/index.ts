import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { format } from "date-fns";
import { config } from "../config.js";

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

const MAX_HISTORY = 10;
const HISTORY_TTL_MS = 60 * 60 * 1000; // 1 hour

function loadFile(userPath: string, defaultPath: string): string {
  try {
    return readFileSync(existsSync(userPath) ? userPath : defaultPath, "utf-8");
  } catch {
    return "";
  }
}

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

function buildSystemPrompt(userName: string, history: ChatMessage[]): string {
  const persona = loadFile(
    join(config.steveDir, "SOUL.md"),
    join(config.defaultsDir, "SOUL.md"),
  );
  const system = loadFile(
    join(config.steveDir, "AGENTS.md"),
    join(config.defaultsDir, "AGENTS.md"),
  );

  const vars: Record<string, string> = {
    date: format(new Date(), "EEEE, MMMM d, yyyy"),
    userName,
    dataDir: config.dataDir,
    projectRoot: config.projectRoot,
  };

  let prompt = persona + "\n\n" + interpolate(system, vars);

  if (history.length > 0) {
    prompt += "\n\n## Recent Conversation\n\n";
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
      const systemPrompt = buildSystemPrompt(userName, history);
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
          "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch",
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
