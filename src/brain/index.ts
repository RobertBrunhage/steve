import * as p from "@clack/prompts";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client";
import { config } from "../config.js";

const sessions: Map<string, string> = new Map();
const queues: Map<string, Promise<void>> = new Map();

let client: OpencodeClient | null = null;

function getClient(): OpencodeClient {
  if (!client) {
    client = createOpencodeClient({
      baseUrl: config.opencodeUrl,
      directory: config.dataDir,
    });
  }
  return client;
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
    const prev = queues.get(userName) ?? Promise.resolve();
    const current = prev.then(() => this.process(userMessage, userName, files));
    queues.set(userName, current);
    await current;
  }

  private async process(
    userMessage: string,
    userName: string,
    files?: string[],
  ): Promise<void> {
    try {
      p.log.step(`${userName} → thinking...`);

      const oc = getClient();
      let sessionId = sessions.get(userName);

      // Create session if needed
      if (!sessionId) {
        const res = await oc.session.create({
          body: { title: `Steve - ${userName}` },
          query: { directory: config.dataDir },
        });
        if (res.data) {
          sessionId = res.data.id;
          sessions.set(userName, sessionId);
        } else {
          throw new Error("Failed to create session");
        }
      }

      // Build message parts
      const parts: Array<{ type: "text"; text: string } | { type: "file"; mime: string; url: string }> = [
        { type: "text", text: `[${userName}]: ${userMessage}` },
      ];

      if (files?.length) {
        for (const file of files) {
          const ext = file.split(".").pop()?.toLowerCase() || "jpg";
          const mimeMap: Record<string, string> = {
            jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
            gif: "image/gif", webp: "image/webp", pdf: "application/pdf",
          };
          parts.push({
            type: "file",
            mime: mimeMap[ext] || "application/octet-stream",
            url: `file://${file}`,
          });
        }
      }

      // Send prompt (fire-and-forget: opencode responds via MCP send_telegram_message)
      const res = await oc.session.prompt({
        path: { id: sessionId },
        body: {
          parts,
          model: {
            providerID: config.model.split("/")[0],
            modelID: config.model.split("/")[1],
          },
        },
        query: { directory: config.dataDir },
      });

      if (res.error) {
        // Session might have expired, try creating a new one
        if (res.response?.status === 404 || res.response?.status === 400) {
          p.log.warn(`Session expired for ${userName}, creating new one...`);
          sessions.delete(userName);
          // Retry once with a new session
          return this.process(userMessage, userName, files);
        }
        throw new Error(`OpenCode error: ${JSON.stringify(res.error)}`);
      }

      p.log.success(`${userName} → replied`);
    } catch (error) {
      p.log.error(`${userName} → failed: ${error instanceof Error ? error.message : error}`);
      await sendFallback(
        userName,
        "Something went wrong on my end. Give me a moment and try again.",
      );
    }
  }

  stopAll() {
    sessions.clear();
  }
}
