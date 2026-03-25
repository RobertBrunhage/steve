import { Bot } from "grammy";
import * as p from "@clack/prompts";

export function createBot(token: string): Bot {
  const bot = new Bot(token);

  bot.catch((err) => {
    p.log.error(`Bot error: ${err.error}`);
  });

  return bot;
}
