import * as p from "@clack/prompts";
import { config, setRuntimeConfig } from "./config.js";
import { runSetup } from "./setup.js";
import { createBot } from "./bot/index.js";
import { registerCommands } from "./bot/commands.js";
import { registerMessageHandler } from "./bot/message-handler.js";
import { Brain } from "./brain/index.js";
import { startScheduler } from "./scheduler.js";
import { createMcpServerFactory } from "./mcp/server.js";
import { startMcpHttpServer } from "./mcp/transport.js";
import { startWebServer } from "./web/index.js";
import { setTelegramConnected, setVaultSecretCount } from "./health.js";
import { TelegramChannel } from "./channels/telegram.js";
import { registerChannel } from "./channels/index.js";

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
  const { vault, botToken, users } = await runSetup();

  p.intro("Steve");

  const hostIp = process.env.STEVE_HOST_IP || "localhost";
  const secretManagerUrl = `http://${hostIp}:${config.webPort}`;

  // Always start web UI (dashboard or setup wizard)
  startWebServer(vault, config.webPort);
  p.log.success(`Web UI at ${secretManagerUrl}`);

  if (!botToken || Object.keys(users).length === 0) {
    // Not configured — wait for web UI setup
    p.log.warn(`Open ${secretManagerUrl}/setup to finish setup`);

    // Poll until configured
    while (!vault.has("telegram/bot_token") || !vault.has("steve/users")) {
      await sleep(2000);
    }

    // Re-read config and continue
    const newToken = vault.getString("telegram/bot_token")!;
    const newUsers = vault.get("steve/users") as Record<string, string>;

    const allowedUserIds = Object.keys(newUsers).map(Number).filter((id) => id > 0);
    setRuntimeConfig({ botToken: newToken, users: newUsers, allowedUserIds });

    // Run full setup now that we have config
    const { runSetup: rerun } = await import("./setup.js");
    await rerun();

    p.log.success("Configuration complete!");

    // Write users.json so launch.ts can start containers
    const userList = [...new Set(Object.values(newUsers).map((n) => n.toLowerCase()))];
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    writeFileSync(
      join(config.dataDir, "users.json"),
      JSON.stringify({ users: userList }, null, 2),
      "utf-8",
    );

    return startServices(vault, newToken, newUsers, secretManagerUrl);
  }

  const allowedUserIds = Object.keys(users).map(Number).filter((id) => id > 0);
  setRuntimeConfig({ botToken, users, allowedUserIds });

  return startServices(vault, botToken, users, secretManagerUrl);
}

async function startServices(vault: any, botToken: string, users: Record<string, string>, secretManagerUrl: string) {
  // MCP server
  const channel = new TelegramChannel(botToken, users);
  registerChannel(channel);

  const mcpFactory = createMcpServerFactory(
    { channel, projectRoot: config.projectRoot, dataDir: config.dataDir, secretManagerUrl },
    vault,
  );
  await startMcpHttpServer(mcpFactory, config.mcpPort);
  p.log.success(`MCP server on :${config.mcpPort}`);

  setVaultSecretCount(vault.list().length);

  // Start services
  const brain = new Brain();
  setTelegramConnected(true);

  await startBot(botToken, brain);
}

main().catch((error) => {
  p.log.error(`Fatal: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
