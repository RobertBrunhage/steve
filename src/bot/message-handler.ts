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

  // Get the largest photo
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

export async function handleBrainMessage(
  ctx: Context,
  brain: Brain,
  userMessage: string,
): Promise<void> {
  await ctx.replyWithChatAction("typing");

  const userId = String(ctx.from?.id ?? "unknown");
  const userName = getUserName(ctx.from?.id ?? 0);
  const chatId = `telegram-${userId}`;

  const reply = await brain.think(userMessage, userName, chatId);

  try {
    await ctx.reply(reply, { parse_mode: "Markdown" });
  } catch {
    await ctx.reply(reply);
  }
}

export function registerMessageHandler(
  bot: Bot,
  brain: Brain,
): void {
  // Text messages
  bot.on("message:text", async (ctx) => {
    await handleBrainMessage(ctx, brain, ctx.message.text);
  });

  // Photos (with optional caption)
  bot.on("message:photo", async (ctx) => {
    await ctx.replyWithChatAction("typing");

    const userId = String(ctx.from?.id ?? "unknown");
    const userName = getUserName(ctx.from?.id ?? 0);
    const chatId = `telegram-${userId}`;
    const caption = ctx.message.caption || "The user sent a photo.";

    const filepath = await downloadPhoto(ctx);
    if (!filepath) {
      await ctx.reply("Sorry, I couldn't download that image.");
      return;
    }

    const message = `${caption}\n\n[Image attached at: ${filepath} - use the Read tool to view it]`;
    const reply = await brain.think(message, userName, chatId);

    // Clean up temp file
    try { await unlink(filepath); } catch {}

    try {
      await ctx.reply(reply, { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(reply);
    }
  });
}
