import { writeFile, mkdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Bot, Context } from "grammy";
import { appendUserActivity } from "../activity.js";
import type { Brain } from "../brain/index.js";
import { config, getRuntime, getTelegramApiBase, getUserDir } from "../config.js";
import { getUserName } from "./commands.js";

type DownloadedPhoto = { hostPath: string; containerPath: string };
type PendingPhotoGroup = {
  ctx: Context;
  userName: string;
  caption: string | null;
  downloads: Promise<DownloadedPhoto | null>[];
  timer: ReturnType<typeof setTimeout>;
};

const PHOTO_GROUP_SETTLE_MS = 750;
const pendingPhotoGroups = new Map<string, PendingPhotoGroup>();

/** Download photo to user's workspace tmp dir. Returns {hostPath, containerPath}. */
async function downloadPhoto(ctx: Context, userName: string): Promise<DownloadedPhoto | null> {
  const photo = ctx.message?.photo;
  if (!photo || photo.length === 0) return null;

  const largest = photo[photo.length - 1];
  const file = await ctx.api.getFile(largest.file_id);
  if (!file.file_path) return null;

  const url = `${getTelegramApiBase()}/file/bot${getRuntime().botToken}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) return null;

  // Save to user's workspace so OpenCode container can access it
  const userTmpDir = join(getUserDir(userName), "tmp");
  await mkdir(userTmpDir, { recursive: true });
  const ext = file.file_path.split(".").pop() || "jpg";
  const filename = `photo-${Date.now()}-${randomUUID()}.${ext}`;
  const hostPath = join(userTmpDir, filename);

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(hostPath, buffer);

  // OpenCode sees the user workspace at /data, so the path inside the container is /data/tmp/filename
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
  await processPhotoMessage(group.ctx, brain, group.userName, group.downloads, group.caption);
}

function queuePhotoGroup(ctx: Context, brain: Brain, userName: string): void {
  const key = getPhotoGroupKey(ctx);
  if (!key) return;

  const caption = normalizeCaption(ctx.message?.caption);
  const existing = pendingPhotoGroups.get(key);
  if (existing) {
    existing.ctx = ctx;
    existing.caption = existing.caption || caption;
    existing.downloads.push(downloadPhoto(ctx, userName));
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => {
      void flushPhotoGroup(key, brain);
    }, PHOTO_GROUP_SETTLE_MS);
    return;
  }

  pendingPhotoGroups.set(key, {
    ctx,
    userName,
    caption,
    downloads: [downloadPhoto(ctx, userName)],
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
): Promise<void> {
  const stopTyping = keepTyping(ctx);
  const userName = getUserName(ctx.from?.id ?? 0);
  appendUserActivity(config.dataDir, {
    timestamp: new Date().toISOString(),
    userName,
    type: "message_received",
    status: "info",
    summary: `Received message: ${userMessage.replace(/\s+/g, " ").trim().slice(0, 120)}`,
  });
  try {
    await brain.think(userMessage, userName);
  } finally {
    stopTyping();
  }
}

export function registerMessageHandler(
  bot: Bot,
  brain: Brain,
): void {
  bot.on("message:text", (ctx) => {
    handleBrainMessage(ctx, brain, ctx.message.text);
  });

  // Inline button callbacks
  bot.on("callback_query:data", (ctx) => {
    const userName = getUserName(ctx.from.id);
    const data = ctx.callbackQuery.data;
    ctx.answerCallbackQuery();
    handleBrainMessage(ctx, brain, data);
  });

  bot.on("message:photo", async (ctx) => {
    const userName = getUserName(ctx.from?.id ?? 0);

    if (ctx.message.media_group_id) {
      queuePhotoGroup(ctx, brain, userName);
      return;
    }

    await processPhotoMessage(
      ctx,
      brain,
      userName,
      [downloadPhoto(ctx, userName)],
      normalizeCaption(ctx.message.caption),
    );
  });
}
