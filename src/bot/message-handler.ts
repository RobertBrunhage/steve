import { writeFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Bot, Context } from "grammy";
import { appendUserActivity } from "../activity.js";
import type { Brain } from "../brain/index.js";
import { config, getRuntime, getTelegramApiBase, getUserDir } from "../config.js";
import { getUserName } from "./commands.js";

/** Download photo to user's workspace tmp dir. Returns {hostPath, containerPath}. */
async function downloadPhoto(ctx: Context, userName: string): Promise<{ hostPath: string; containerPath: string } | null> {
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
  const filename = `photo-${Date.now()}.${ext}`;
  const hostPath = join(userTmpDir, filename);

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(hostPath, buffer);

  // OpenCode sees the user workspace at /data, so the path inside the container is /data/tmp/filename
  const containerPath = `/data/tmp/${filename}`;

  return { hostPath, containerPath };
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

  bot.on("message:photo", (ctx) => {
    const userName = getUserName(ctx.from?.id ?? 0);
    const caption = ctx.message.caption || "The user sent a photo.";
    appendUserActivity(config.dataDir, {
      timestamp: new Date().toISOString(),
      userName,
      type: "message_received",
      status: "info",
      summary: `Received photo${ctx.message.caption ? `: ${caption.replace(/\s+/g, " ").trim().slice(0, 100)}` : ""}`,
    });

    downloadPhoto(ctx, userName).then((photo) => {
      if (!photo) {
        ctx.reply("Sorry, I couldn't download that image.");
        return;
      }
      const stopTyping = keepTyping(ctx);
      brain.think(caption, userName, [photo.containerPath]).finally(() => {
        stopTyping();
        unlink(photo.hostPath).catch(() => {});
      });
    });
  });
}
