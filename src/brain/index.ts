import * as p from "@clack/prompts";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/client";
import { APP_NAME, APP_SLUG, LEGACY_APP_NAME } from "../brand.js";
import { getDefaultChannel } from "../channels/index.js";
import { resolveUserAgentId } from "../user-agents.js";
import { toUserSlug } from "../users.js";

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fallback "something went wrong" message when OpenCode fails entirely.
// Routes through the registered channel so an agent-specific bot/chat is used
// when configured, instead of always falling back to the main kellix bot.
async function sendFallback(userName: string, message: string, agentId?: string) {
  const channel = getDefaultChannel();
  if (!channel) return;
  try {
    await channel.sendMessage(userName, message, agentId ? { agentId } : undefined);
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
    agentId?: string,
  ): Promise<void> {
    const resolvedAgentId = resolveUserAgentId(userName, agentId);
    const queueKey = this.getClientKey(userName, resolvedAgentId);
    const prev = this.queues.get(queueKey) ?? Promise.resolve();
    const current = prev.then(() => this.process(userMessage, userName, files, resolvedAgentId));
    this.queues.set(queueKey, current);
    await current;
  }

  private getClientKey(userName: string, agentId: string): string {
    return `${toUserSlug(userName)}:${toUserSlug(agentId)}`;
  }

  private getClient(userName: string, agentId: string): OpencodeClient {
    const key = this.getClientKey(userName, agentId);
    if (!this.clients.has(key)) {
      this.clients.set(key, createOpencodeClient({
        baseUrl: `http://opencode-${toUserSlug(userName)}-${toUserSlug(agentId)}:3456`,
        directory: "/data",
      }));
    }
    return this.clients.get(key)!;
  }

  private getSessionTitle(userName: string, agentId: string): string {
    return agentId === APP_SLUG ? `${APP_NAME} - ${userName}` : `${APP_NAME} ${agentId} - ${userName}`;
  }

  private async findExistingSessionId(oc: OpencodeClient, userName: string, agentId: string): Promise<string | null> {
    try {
      const list = await oc.session.list({});
      const titles = new Set([this.getSessionTitle(userName, agentId)]);
      if (agentId === APP_SLUG) titles.add(`${LEGACY_APP_NAME} - ${userName}`);
      const existing = (list.data as any[])?.find(
        (s: any) => titles.has(String(s.title || "")) && !s.time?.archived,
      );
      return existing?.id ? String(existing.id) : null;
    } catch {
      return null;
    }
  }

  private async createSessionId(oc: OpencodeClient, userName: string, agentId: string): Promise<string> {
    const res = await oc.session.create({ body: { title: this.getSessionTitle(userName, agentId) } });
    if (!res.data?.id) {
      throw new Error("Failed to create session");
    }
    return res.data.id;
  }

  private async getOrCreateSessionId(oc: OpencodeClient, userName: string, agentId: string): Promise<string> {
    const key = this.getClientKey(userName, agentId);
    const cached = this.sessions.get(key);
    if (cached) return cached;

    const existing = await this.findExistingSessionId(oc, userName, agentId);
    if (existing) {
      this.sessions.set(key, existing);
      p.log.info(`Resumed session for ${userName}/${agentId}`);
      return existing;
    }

    const created = await this.createSessionId(oc, userName, agentId);
    this.sessions.set(key, created);
    return created;
  }

  private async getPrimarySessionId(oc: OpencodeClient, userName: string, agentId: string): Promise<string | null> {
    const key = this.getClientKey(userName, agentId);
    const cached = this.sessions.get(key);
    if (cached) return cached;
    const existing = await this.findExistingSessionId(oc, userName, agentId);
    if (existing) {
      this.sessions.set(key, existing);
      return existing;
    }
    return null;
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

  private async promptSession(oc: OpencodeClient, sessionId: string, parts: PromptPart[], agentId: string) {
    return oc.session.prompt({
      path: { id: sessionId },
      body: { parts, agent: agentId },
    });
  }

  private async getConfiguredModel(oc: OpencodeClient): Promise<{ providerID: string; modelID: string } | undefined> {
    const configRes = await oc.config.get({});
    const configuredModel = configRes.data?.model;
    return configuredModel && configuredModel.includes("/")
      ? {
          providerID: configuredModel.split("/")[0]!,
          modelID: configuredModel.slice(configuredModel.indexOf("/") + 1),
        }
      : undefined;
  }

  private async promptWithSessionRetry(oc: OpencodeClient, userName: string, parts: PromptPart[], agentId: string) {
    const key = this.getClientKey(userName, agentId);

    for (let attempt = 0; attempt < 2; attempt++) {
      const sessionId = attempt === 0
        ? await this.getOrCreateSessionId(oc, userName, agentId)
        : await this.createSessionId(oc, userName, agentId);

      if (attempt > 0) {
        this.sessions.set(key, sessionId);
      }

      const res = await this.promptSession(oc, sessionId, parts, agentId);
      if (!res.error) {
        return res;
      }

      if (attempt === 0 && (res.response?.status === 404 || res.response?.status === 400)) {
        p.log.warn(`Session expired for ${userName}/${agentId}, creating new one...`);
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
    agentId = APP_SLUG,
  ): Promise<void> {
    try {
      p.log.step(`${userName}/${agentId} → thinking...`);

      const oc = this.getClient(userName, agentId);
      const parts = this.buildPromptParts(userMessage, files);
      await this.promptWithSessionRetry(oc, userName, parts, agentId);

      p.log.success(`${userName}/${agentId} → replied`);
    } catch (error) {
      p.log.error(`${userName}/${agentId} → failed: ${error instanceof Error ? error.message : error}`);
      await sendFallback(
        userName,
        "Something went wrong on my end. Give me a moment and try again.",
        agentId,
      );
    }
  }

  /** Run a prompt in an isolated session (for cron/heartbeats — doesn't pollute user's conversation) */
  async thinkIsolated(
    userMessage: string,
    userName: string,
    agentId?: string,
  ): Promise<void> {
    const resolvedAgentId = resolveUserAgentId(userName, agentId);
    try {
      const oc = this.getClient(userName, resolvedAgentId);
      const sessionId = await this.createSessionId(oc, `${userName} (isolated)`, resolvedAgentId);
      const res = await this.promptSession(oc, sessionId, this.buildPromptParts(userMessage), resolvedAgentId);

      if (res.error) {
        throw new Error(`OpenCode error: ${JSON.stringify(res.error)}`);
      }
    } catch (error) {
      p.log.error(`Isolated task failed for ${userName}/${resolvedAgentId}: ${error instanceof Error ? error.message : error}`);
      throw error;
    }
  }

  async compactPrimarySession(userName: string, agentId?: string): Promise<boolean> {
    const resolvedAgentId = resolveUserAgentId(userName, agentId);
    const key = this.getClientKey(userName, resolvedAgentId);
    const oc = this.getClient(userName, resolvedAgentId);
    const model = await this.getConfiguredModel(oc);

    if (!model) {
      throw new Error(`No configured model for ${userName}/${resolvedAgentId}`);
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const sessionId = await this.getPrimarySessionId(oc, userName, resolvedAgentId);
      if (!sessionId) {
        return false;
      }

      const res = await oc.session.summarize({ path: { id: sessionId }, body: model });
      if (!res.error) {
        // The OpenCode memory plugin records the compaction summary to disk from
        // the session.compacted event. Give that handler a short window to fetch
        // messages before removing the now-summarized chat history.
        await sleep(2000);
        const deleteRes = await oc.session.delete({ path: { id: sessionId } });
        if (deleteRes.error) {
          throw new Error(`OpenCode delete error: ${JSON.stringify(deleteRes.error)}`);
        }
        this.sessions.delete(key);
        return true;
      }

      if (attempt === 0 && (res.response?.status === 404 || res.response?.status === 400)) {
        this.sessions.delete(key);
        continue;
      }

      throw new Error(`OpenCode error: ${JSON.stringify(res.error)}`);
    }

    return false;
  }

  stopAll() {
    this.sessions.clear();
    this.clients.clear();
    this.queues.clear();
  }
}
