import * as p from "@clack/prompts";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client";
import { getRuntime } from "../config.js";
import { findUserId, toUserSlug } from "../users.js";

type PromptPart =
  | { type: "text"; text: string }
  | { type: "file"; mime: string; url: string };

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
};

// Direct Telegram API call as fallback when opencode fails entirely
async function sendFallback(userName: string, message: string) {
  const rt = getRuntime();
  const chatId = findUserId(rt.users, userName);

  if (!chatId || !rt.botToken) return;

  try {
    await fetch(
      `https://api.telegram.org/bot${rt.botToken}/sendMessage`,
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
  private readonly sessions = new Map<string, string>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly clients = new Map<string, OpencodeClient>();

  async think(
    userMessage: string,
    userName: string,
    files?: string[],
  ): Promise<void> {
    const queueKey = toUserSlug(userName);
    const prev = this.queues.get(queueKey) ?? Promise.resolve();
    const current = prev.then(() => this.process(userMessage, userName, files));
    this.queues.set(queueKey, current);
    await current;
  }

  private getClient(userName: string): OpencodeClient {
    const name = toUserSlug(userName);
    if (!this.clients.has(name)) {
      this.clients.set(name, createOpencodeClient({
        baseUrl: `http://opencode-${name}:3456`,
        directory: "/data",
      }));
    }
    return this.clients.get(name)!;
  }

  private async findExistingSessionId(oc: OpencodeClient, userName: string): Promise<string | null> {
    try {
      const list = await oc.session.list({});
      const existing = (list.data as any[])?.find(
        (s: any) => s.title === `Steve - ${userName}` && !s.time?.archived,
      );
      return existing?.id ? String(existing.id) : null;
    } catch {
      return null;
    }
  }

  private async createSessionId(oc: OpencodeClient, userName: string): Promise<string> {
    const res = await oc.session.create({ body: { title: `Steve - ${userName}` } });
    if (!res.data?.id) {
      throw new Error("Failed to create session");
    }
    return res.data.id;
  }

  private async getOrCreateSessionId(oc: OpencodeClient, userName: string): Promise<string> {
    const key = toUserSlug(userName);
    const cached = this.sessions.get(key);
    if (cached) return cached;

    const existing = await this.findExistingSessionId(oc, userName);
    if (existing) {
      this.sessions.set(key, existing);
      p.log.info(`Resumed session for ${userName}`);
      return existing;
    }

    const created = await this.createSessionId(oc, userName);
    this.sessions.set(key, created);
    return created;
  }

  private buildPromptParts(userMessage: string, files?: string[]): PromptPart[] {
    const parts: PromptPart[] = [{ type: "text", text: userMessage }];

    for (const file of files ?? []) {
      const ext = file.split(".").pop()?.toLowerCase() || "jpg";
      parts.push({
        type: "file",
        mime: MIME_BY_EXTENSION[ext] || "application/octet-stream",
        url: `file://${file}`,
      });
    }

    return parts;
  }

  private async promptSession(oc: OpencodeClient, sessionId: string, parts: PromptPart[]) {
    return oc.session.prompt({
      path: { id: sessionId },
      body: { parts },
    });
  }

  private async promptWithSessionRetry(oc: OpencodeClient, userName: string, parts: PromptPart[]) {
    const key = toUserSlug(userName);

    for (let attempt = 0; attempt < 2; attempt++) {
      const sessionId = attempt === 0
        ? await this.getOrCreateSessionId(oc, userName)
        : await this.createSessionId(oc, userName);

      if (attempt > 0) {
        this.sessions.set(key, sessionId);
      }

      const res = await this.promptSession(oc, sessionId, parts);
      if (!res.error) {
        return res;
      }

      if (attempt === 0 && (res.response?.status === 404 || res.response?.status === 400)) {
        p.log.warn(`Session expired for ${userName}, creating new one...`);
        this.sessions.delete(key);
        continue;
      }

      throw new Error(`OpenCode error: ${JSON.stringify(res.error)}`);
    }

    throw new Error("Failed to prompt OpenCode");
  }

  private async process(
    userMessage: string,
    userName: string,
    files?: string[],
  ): Promise<void> {
    try {
      p.log.step(`${userName} → thinking...`);

      const oc = this.getClient(userName);
      const parts = this.buildPromptParts(userMessage, files);
      await this.promptWithSessionRetry(oc, userName, parts);

      p.log.success(`${userName} → replied`);
    } catch (error) {
      p.log.error(`${userName} → failed: ${error instanceof Error ? error.message : error}`);
      await sendFallback(
        userName,
        "Something went wrong on my end. Give me a moment and try again.",
      );
    }
  }

  /** Run a prompt in an isolated session (for cron/heartbeats — doesn't pollute user's conversation) */
  async thinkIsolated(
    userMessage: string,
    userName: string,
  ): Promise<void> {
    try {
      const oc = this.getClient(userName);
      const sessionId = await this.createSessionId(oc, `${userName} (isolated)`);
      const res = await this.promptSession(oc, sessionId, this.buildPromptParts(userMessage));

      if (res.error) {
        throw new Error(`OpenCode error: ${JSON.stringify(res.error)}`);
      }
    } catch (error) {
      p.log.error(`Isolated task failed for ${userName}: ${error instanceof Error ? error.message : error}`);
    }
  }

  stopAll() {
    this.sessions.clear();
    this.clients.clear();
    this.queues.clear();
  }
}
