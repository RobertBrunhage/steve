import { writeFile, mkdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Bot, Context } from "grammy";
import { appendUserActivity } from "../activity.js";
import type { Brain } from "../brain/index.js";
import { config, getRuntime, getTelegramApiBase, getUserAgentDir } from "../config.js";
import { resolveUserAgentId } from "../user-agents.js";
import { decodeApprovalPayload } from "../workflows/steps/approval.js";
import type { WorkflowRunner } from "../workflows/runner.js";
import { getUserName } from "./commands.js";

type DownloadedPhoto = { hostPath: string; containerPath: string };
type BotRoute = { userName: string; agentId?: string; botToken?: string };
type PendingPhotoGroup = {
  ctx: Context;
  userName: string;
  route?: BotRoute;
  caption: string | null;
  downloads: Promise<DownloadedPhoto | null>[];
  timer: ReturnType<typeof setTimeout>;
};

const PHOTO_GROUP_SETTLE_MS = 750;
const pendingPhotoGroups = new Map<string, PendingPhotoGroup>();

/** Download photo to the target agent's workspace tmp dir. Returns {hostPath, containerPath}. */
async function downloadPhoto(ctx: Context, userName: string, agentId: string, botToken?: string): Promise<DownloadedPhoto | null> {
  const photo = ctx.message?.photo;
  if (!photo || photo.length === 0) return null;

  const largest = photo[photo.length - 1];
  const file = await ctx.api.getFile(largest.file_id);
  if (!file.file_path) return null;

  const url = `${getTelegramApiBase()}/file/bot${botToken || getRuntime().botToken}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) return null;

  // Save into the agent's workspace tmp dir. The OpenCode container for this
  // agent mounts that dir as /data, so /data/tmp/<file> resolves correctly.
  const agentTmpDir = join(getUserAgentDir(userName, agentId), "tmp");
  await mkdir(agentTmpDir, { recursive: true });
  const ext = file.file_path.split(".").pop() || "jpg";
  const filename = `photo-${Date.now()}-${randomUUID()}.${ext}`;
  const hostPath = join(agentTmpDir, filename);

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(hostPath, buffer);

  const containerPath = `/data/tmp/${filename}`;

  return { hostPath, containerPath };
}

function normalizeCaption(caption: string | undefined): string | null {
  const trimmed = caption?.trim();
  return trimmed ? trimmed : null;
}

function getPhotoPrompt(caption: string | null, photoPaths: string[]): string {
  const base = caption || (photoPaths.length > 1 ? "The user sent photos." : "The user sent a photo.");
  const attachments = photoPaths.length > 0
    ? `\n\nAttached file paths:\n${photoPaths.map((path) => `- ${path}`).join("\n")}`
    : "";
  return `${base}${attachments}`;
}

function appendPhotoActivity(userName: string, photoCount: number, caption: string | null) {
  const summary = photoCount > 1 ? `Received ${photoCount} photos` : "Received photo";
  appendUserActivity(config.dataDir, {
    timestamp: new Date().toISOString(),
    userName,
    type: "message_received",
    status: "info",
    summary: `${summary}${caption ? `: ${caption.replace(/\s+/g, " ").trim().slice(0, 100)}` : ""}`,
  });
}

async function cleanupPhotos(photos: DownloadedPhoto[]): Promise<void> {
  await Promise.all(photos.map((photo) => unlink(photo.hostPath).catch(() => {})));
}

async function processPhotoMessage(
  ctx: Context,
  brain: Brain,
  userName: string,
  route: BotRoute | undefined,
  downloads: Promise<DownloadedPhoto | null>[],
  caption: string | null,
): Promise<void> {
  const photos = (await Promise.all(downloads)).filter((photo): photo is DownloadedPhoto => !!photo);
  appendPhotoActivity(userName, Math.max(downloads.length, photos.length, 1), caption);

  if (photos.length === 0) {
    await ctx.reply("Sorry, I couldn't download that image.");
    return;
  }

  const stopTyping = keepTyping(ctx);
  try {
    const photoPaths = photos.map((photo) => photo.containerPath);
    await brain.think(
      getPhotoPrompt(caption, photoPaths),
      userName,
      photoPaths,
      route?.agentId,
    );
  } finally {
    stopTyping();
    await cleanupPhotos(photos);
  }
}

function getPhotoGroupKey(ctx: Context): string | null {
  const mediaGroupId = ctx.message?.media_group_id;
  if (!mediaGroupId) return null;
  return `${ctx.chat?.id ?? ctx.from?.id ?? "unknown"}:${mediaGroupId}`;
}

async function flushPhotoGroup(key: string, brain: Brain): Promise<void> {
  const group = pendingPhotoGroups.get(key);
  if (!group) return;
  pendingPhotoGroups.delete(key);
  await processPhotoMessage(group.ctx, brain, group.userName, group.route, group.downloads, group.caption);
}

function queuePhotoGroup(ctx: Context, brain: Brain, userName: string, agentId: string, route?: BotRoute): void {
  const key = getPhotoGroupKey(ctx);
  if (!key) return;

  const caption = normalizeCaption(ctx.message?.caption);
  const existing = pendingPhotoGroups.get(key);
  if (existing) {
    existing.ctx = ctx;
    existing.caption = existing.caption || caption;
    existing.downloads.push(downloadPhoto(ctx, userName, agentId, route?.botToken));
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => {
      void flushPhotoGroup(key, brain);
    }, PHOTO_GROUP_SETTLE_MS);
    return;
  }

  pendingPhotoGroups.set(key, {
    ctx,
    userName,
    route,
    caption,
    downloads: [downloadPhoto(ctx, userName, agentId, route?.botToken)],
    timer: setTimeout(() => {
      void flushPhotoGroup(key, brain);
    }, PHOTO_GROUP_SETTLE_MS),
  });
}

function keepTyping(ctx: Context): () => void {
  const send = () => ctx.replyWithChatAction("typing").catch(() => {});
  send();
  const interval = setInterval(send, 4000);
  return () => clearInterval(interval);
}

export async function handleBrainMessage(
  ctx: Context,
  brain: Brain,
  userMessage: string,
  route?: BotRoute,
): Promise<void> {
  const stopTyping = keepTyping(ctx);
  const userName = route?.userName || getUserName(ctx.from?.id ?? 0);
  appendUserActivity(config.dataDir, {
    timestamp: new Date().toISOString(),
    userName,
    type: "message_received",
    status: "info",
    summary: `Received message: ${userMessage.replace(/\s+/g, " ").trim().slice(0, 120)}`,
  });
  try {
    await brain.think(userMessage, userName, undefined, route?.agentId);
  } finally {
    stopTyping();
  }
}

export function registerMessageHandler(
  bot: Bot,
  brain: Brain,
  route?: BotRoute,
  engine?: WorkflowRunner,
): void {
  bot.on("message:text", (ctx) => {
    const text = ctx.message.text;
    const userName = route?.userName || getUserName(ctx.from?.id ?? 0);
    const agentId = resolveUserAgentId(userName, route?.agentId);
    // First, see if there's a pending workflow approval to consume.
    if (engine && engine.tryConsumeAsApprovalReply(userName, agentId, text, userName)) {
      ctx.reply("Workflow resumed.").catch(() => {});
      return;
    }
    handleBrainMessage(ctx, brain, text, route);
  });

  // Inline button callbacks
  bot.on("callback_query:data", (ctx) => {
    const userName = route?.userName || getUserName(ctx.from.id);
    const data = ctx.callbackQuery.data;
    ctx.answerCallbackQuery();

    // Workflow approval button: payload is wf:<instanceId>:<stepId>:<labelB64>
    const decoded = decodeApprovalPayload(data);
    if (decoded && engine) {
      const ok = engine.resume({ instanceId: decoded.instanceId, response: decoded.label, approvedBy: userName });
      if (ok) {
        ctx.reply(`Workflow approval received: ${decoded.label}`).catch(() => {});
        return;
      }
    }

    handleBrainMessage(ctx, brain, data, route ? { ...route, userName } : undefined);
  });

  bot.on("message:photo", async (ctx) => {
    const userName = route?.userName || getUserName(ctx.from?.id ?? 0);
    const agentId = resolveUserAgentId(userName, route?.agentId);
    const scopedRoute = route ? { ...route, userName } : undefined;

    if (ctx.message.media_group_id) {
      queuePhotoGroup(ctx, brain, userName, agentId, scopedRoute);
      return;
    }

    await processPhotoMessage(
      ctx,
      brain,
      userName,
      scopedRoute,
      [downloadPhoto(ctx, userName, agentId, route?.botToken)],
      normalizeCaption(ctx.message.caption),
    );
  });
}
