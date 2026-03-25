import { writeFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Bot, Context } from "grammy";
import type { Brain } from "../brain/index.js";
import { config } from "../config.js";
import { getUserName } from "./commands.js";

const tmpDir = join(config.dataDir, "tmp");

async function downloadPhoto(ctx: Context): Promise<string | null> {
  const photo = ctx.message?.photo;
  if (!photo || photo.length === 0) return null;

  const largest = photo[photo.length - 1];
  const file = await ctx.api.getFile(largest.file_id);
  if (!file.file_path) return null;

  const url = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
  const response = await fetch(url);
  if (!response.ok) return null;

  await mkdir(tmpDir, { recursive: true });
  const ext = file.file_path.split(".").pop() || "jpg";
  const filename = `photo-${Date.now()}.${ext}`;
  const filepath = join(tmpDir, filename);

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(filepath, buffer);

  return filepath;
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
  bot.on("message:text", async (ctx) => {
    await handleBrainMessage(ctx, brain, ctx.message.text);
  });

  bot.on("message:photo", async (ctx) => {
    const stopTyping = keepTyping(ctx);

    const userName = getUserName(ctx.from?.id ?? 0);
    const caption = ctx.message.caption || "The user sent a photo.";

    const filepath = await downloadPhoto(ctx);
    if (!filepath) {
      stopTyping();
      await ctx.reply("Sorry, I couldn't download that image.");
      return;
    }

    try {
      await brain.think(caption, userName, [filepath]);
    } finally {
      stopTyping();
      try { await unlink(filepath); } catch {}
    }
  });
}
