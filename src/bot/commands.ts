import type { Bot } from "grammy";
import { APP_NAME } from "../brand.js";
import type { Brain } from "../brain/index.js";
import { getRuntime } from "../config.js";
import { findUserByTelegramId } from "../users.js";
import { handleBrainMessage } from "./message-handler.js";

export function getUserName(telegramId: number): string {
  return findUserByTelegramId(getRuntime().users, telegramId)?.name || "User";
}

export function registerCommands(
  bot: Bot,
  brain: Brain,
  route?: { userName: string; agentId?: string; botToken?: string },
): void {
  // Security: only allow configured users
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    const allowed = route?.userName
      ? true
      : !!userId && getRuntime().allowedUserIds.includes(userId);
    if (!allowed) {
      return;
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    const name = route?.userName || getUserName(ctx.from?.id ?? 0);
    await ctx.reply(
      `Hey ${name}! I'm ${APP_NAME}, your personal assistant.\n\nJust talk to me about anything. I can help with training, planning, notes, or whatever you need.`,
    );
  });

  bot.command("today", (ctx) =>
    handleBrainMessage(ctx, brain, "What's on my plan for today?", route));

  bot.command("schedule", (ctx) => {
    const arg = ctx.match;
    return handleBrainMessage(ctx, brain,
      arg ? `Here is my new training schedule: ${arg}` : "Show me my current training schedule", route);
  });

  bot.command("history", (ctx) => {
    const arg = ctx.match;
    return handleBrainMessage(ctx, brain,
      arg ? `Show me my training history: ${arg}` : "Show me my recent training history", route);
  });
}
