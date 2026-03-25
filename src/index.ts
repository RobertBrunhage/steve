import * as p from "@clack/prompts";
import { config } from "./config.js";
import { runSetup } from "./setup.js";
import { createBot } from "./bot/index.js";
import { registerCommands } from "./bot/commands.js";
import { registerMessageHandler } from "./bot/message-handler.js";
import { Brain } from "./brain/index.js";
import { startScheduler } from "./scheduler.js";
import { startAutoSync } from "./sync.js";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function startBot(botToken: string, brain: Brain) {
  const MAX_RETRIES = 5;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const bot = createBot(botToken);

    registerCommands(bot, brain);
    registerMessageHandler(bot, brain);

    await bot.api.setMyCommands([
      { command: "start", description: "Start Steve" },
      { command: "today", description: "What's on today?" },
      { command: "schedule", description: "View or update training schedule" },
      { command: "history", description: "View recent training history" },
    ]);

    startScheduler(brain);

    await bot.api.deleteWebhook({ drop_pending_updates: true });

    try {
      if (attempt > 1) {
        p.log.warn(`Connecting to Telegram (attempt ${attempt})`);
      }

      await new Promise<void>((resolve, reject) => {
        bot.start({
          onStart: () => {
            p.log.success("Listening for messages");
            resolve();
          },
        });

        bot.catch((err) => {
          p.log.error(`Bot error: ${err.error}`);
        });

        const handler = (err: any) => {
          if (err?.error_code === 409) {
            process.removeListener("unhandledRejection", handler);
            bot.stop();
            reject(err);
          }
        };
        process.on("unhandledRejection", handler);

        sleep(5000).then(() => {
          process.removeListener("unhandledRejection", handler);
          resolve();
        });
      });

      const shutdown = () => {
        p.outro("Steve stopped");
        brain.stopAll();
        bot.stop();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return;
    } catch (err: any) {
      if (err?.error_code === 409 && attempt < MAX_RETRIES) {
        p.log.warn("Telegram conflict, retrying in 10s...");
        await sleep(10_000);
      } else {
        throw err;
      }
    }
  }
}

async function main() {
  const ready = await runSetup();
  if (!ready) process.exit(1);

  const { config: freshConfig } = await import("./config.js");

  if (!freshConfig.telegram.botToken) {
    p.log.error("No Telegram bot token configured. Run setup again.");
    process.exit(1);
  }

  p.intro("Steve");

  const brain = new Brain();
  startAutoSync();
  await startBot(freshConfig.telegram.botToken, brain);
}

main().catch((error) => {
  p.log.error(`Fatal: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
