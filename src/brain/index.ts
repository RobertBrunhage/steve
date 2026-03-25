import { spawn } from "node:child_process";
import * as p from "@clack/prompts";
import { config } from "../config.js";

const sessions: Map<string, string> = new Map();

function extractSessionId(output: string): string | null {
  const lines = output.trim().split("\n");
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.sessionID) return event.sessionID;
    } catch {}
  }
  return null;
}

function logErrors(output: string) {
  for (const line of output.trim().split("\n")) {
    try {
      const event = JSON.parse(line);
      if (event.type === "error" || event.error) {
        const msg = event.error?.data?.message || event.error?.name || "unknown";
        p.log.error(`OpenCode: ${msg}`);
      }
    } catch {}
  }
}

// Direct Telegram API call as fallback when opencode fails entirely
async function sendFallback(userName: string, message: string) {
  const chatId = Object.entries(config.telegram.users).find(
    ([, name]) => name.toLowerCase() === userName.toLowerCase(),
  )?.[0];

  if (!chatId || !config.telegram.botToken) return;

  try {
    await fetch(
      `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: message }),
      },
    );
  } catch (err) {
    p.log.error(`Fallback send failed: ${err instanceof Error ? err.message : err}`);
  }
}

export class Brain {
  async think(
    userMessage: string,
    userName: string,
    files?: string[],
  ): Promise<void> {
    try {
      p.log.step(`${userName} → thinking...`);
      const raw = await this.callOpenCode(userMessage, userName, files);

      const sessionId = extractSessionId(raw);
      if (sessionId) sessions.set(userName, sessionId);

      p.log.success(`${userName} → replied`);
    } catch (error) {
      p.log.error(`${userName} → failed: ${error instanceof Error ? error.message : error}`);
      await sendFallback(
        userName,
        "Something went wrong on my end. Give me a moment and try again.",
      );
    }
  }

  private callOpenCode(message: string, userName: string, files?: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        "run",
        "--format", "json",
        "--dir", config.dataDir,
        "--model", config.model,
      ];

      const sessionId = sessions.get(userName);
      if (sessionId) {
        args.push("--session", sessionId);
      }

      if (files?.length) {
        for (const file of files) {
          args.push("--file", file);
        }
      }

      args.push("--", `[${userName}]: ${message}`);

      const proc = spawn("opencode", args, {
        stdio: ["ignore", "pipe", "pipe"],
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

      proc.on("close", (code) => {
        if (stderr) {
          p.log.warn(stderr.substring(0, 200).trim());
        }
        if (stdout) {
          logErrors(stdout);
        }
        if (code !== 0 && !stdout) {
          reject(new Error(`opencode exited with code ${code}`));
          return;
        }
        resolve(stdout);
      });

      proc.on("error", (err) => {
        reject(err);
      });
    });
  }

  stopAll() {
    sessions.clear();
  }
}
