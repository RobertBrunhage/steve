import { spawn, type ChildProcess } from "node:child_process";
import * as p from "@clack/prompts";
import { config } from "./config.js";
import { runSetup } from "./setup.js";
import { createBot } from "./bot/index.js";
import { registerCommands } from "./bot/commands.js";
import { registerMessageHandler } from "./bot/message-handler.js";
import { Brain } from "./brain/index.js";
import { startScheduler } from "./scheduler.js";
import { startAutoSync } from "./sync.js";
import { createMcpServer } from "./mcp/server.js";
import { startMcpHttpServer } from "./mcp/transport.js";
import { startWebServer } from "./web/index.js";

let opencodeProcess: ChildProcess | null = null;

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
        if (opencodeProcess) opencodeProcess.kill();
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
  // Step 1: Setup (vault password, first-run, generate config)
  const { vault, botToken, users, model, webServerStarted } = await runSetup();

  p.intro("Steve");

  // Step 2: Start MCP HTTP server
  const hostIp = process.env.STEVE_HOST_IP || "localhost";
  const secretManagerUrl = `http://${hostIp}:${config.webPort}`;

  const mcpServer = createMcpServer(
    { botToken, users, projectRoot: config.projectRoot, dataDir: config.dataDir, secretManagerUrl },
    vault,
  );
  await startMcpHttpServer(mcpServer, vault, config.mcpPort);
  p.log.success(`MCP server on :${config.mcpPort}`);

  // Step 3: Start opencode serve (locally, Docker handles this via container)
  if (!config.isDocker) {
    opencodeProcess = spawn("opencode", [
      "serve", "--port", new URL(config.opencodeUrl).port,
      "--hostname", "127.0.0.1",
    ], { stdio: "ignore", cwd: config.dataDir });

    opencodeProcess.on("error", () => {
      p.log.error("Failed to start opencode serve. Is opencode installed?");
    });

    // Wait for it to be ready
    for (let i = 0; i < 20; i++) {
      try {
        await fetch(config.opencodeUrl);
        break;
      } catch {
        await sleep(500);
      }
    }
    p.log.success("OpenCode serve started");
  }

  // Step 4: Start web UI for secret management (skip if setup already started it)
  if (!webServerStarted) {
    startWebServer(vault, config.webPort);
  }
  p.log.success(`Secret manager at http://localhost:${config.webPort}`);

  // Step 5: Start services
  const brain = new Brain();
  if (!config.isDocker) {
    startAutoSync();
  }
  await startBot(botToken, brain);
}

main().catch((error) => {
  p.log.error(`Fatal: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
