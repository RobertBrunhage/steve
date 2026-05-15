import * as p from "@clack/prompts";
import { APP_NAME } from "./brand.js";
import { listEnabledUserAgents, readUserAgentState } from "./agents.js";
import { config, setRuntimeConfig, getBaseUrl } from "./config.js";
import { runSetup } from "./setup.js";
import { createBot } from "./bot/index.js";
import { registerCommands } from "./bot/commands.js";
import { registerMessageHandler } from "./bot/message-handler.js";
import { Brain } from "./brain/index.js";
import { startScheduler } from "./scheduler.js";
import { createMcpServerFactory } from "./mcp/server.js";
import { startMcpHttpServer } from "./mcp/transport.js";
import { startWebServer } from "./web/index.js";
import { getComposeProject, reconcileUserAgents } from "./web/docker.js";
import { setTelegramConnected, setVault } from "./health.js";
import { TelegramChannel } from "./channels/telegram.js";
import { registerChannel } from "./channels/index.js";
import { createWorkflowEngine } from "./workflows/index.js";
import { hasKeyfile } from "./vault/index.js";
import { getAgentTelegramBotToken, getTelegramBotToken } from "./secrets.js";
import { getAllowedTelegramIds, normalizeUsers, readUsersFromVault, type UsersMap, writeUserManifest } from "./users.js";
import type { Vault } from "./vault/index.js";
import { getBrowserService } from "./browser/index.js";
import { listTelegramAgentRoutes } from "./user-agents.js";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(condition: () => boolean, intervalMs = 2000) {
  while (!condition()) {
    await sleep(intervalMs);
  }
}

function applyRuntimeConfig(botToken: string, users: UsersMap) {
  const allowedUserIds = getAllowedTelegramIds(users);
  setRuntimeConfig({ botToken, users, allowedUserIds });
}

async function waitForVault(vault: Vault | null): Promise<Vault> {
  if (vault) return vault;

  p.log.warn("Open the one-time setup link to finish setup");
  await waitFor(() => hasKeyfile(config.vaultDir));

  const setup = await runSetup();
  if (!setup.vault) {
    p.log.error("Vault initialization failed");
    process.exit(1);
  }

  return setup.vault;
}

async function waitForConfiguration(vault: Vault, botToken: string, users: UsersMap): Promise<{ botToken: string; users: UsersMap }> {
  if (botToken && Object.keys(users).length > 0) {
    return { botToken, users };
  }

  p.log.warn("Open the one-time setup link to finish setup");
  await waitFor(() => !!getTelegramBotToken(vault) && Object.keys(readUsersFromVault(vault)).length > 0);

  const nextBotToken = getTelegramBotToken(vault);
  const nextUsers = readUsersFromVault(vault);
  if (!nextBotToken || Object.keys(nextUsers).length === 0) {
    p.log.error("Configuration completed but runtime values were missing");
    process.exit(1);
  }

  await runSetup();
  p.log.success("Configuration complete!");
  writeUserManifest(config.dataDir, nextUsers);

  return { botToken: nextBotToken, users: nextUsers };
}

async function startBot(botToken: string, brain: Brain, route?: { userName: string; agentId?: string; botToken?: string }) {
  const MAX_RETRIES = 5;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const bot = createBot(botToken);

    registerCommands(bot, brain, route);
    registerMessageHandler(bot, brain, route);

      await bot.api.setMyCommands([
      { command: "start", description: "Start Kellix" },
      { command: "today", description: "What's on today?" },
      { command: "schedule", description: "View or update training schedule" },
      { command: "history", description: "View recent training history" },
    ]);

    await bot.api.deleteWebhook({ drop_pending_updates: true });

    try {
      if (attempt > 1) {
        p.log.warn(`Connecting to Telegram (attempt ${attempt})`);
      }

      await new Promise<void>((resolve, reject) => {
        bot.start({
          onStart: () => {
            p.log.success(route?.agentId ? `Listening for ${route.userName}/${route.agentId}` : "Listening for messages");
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
        p.outro(`${APP_NAME} stopped`);
        void getBrowserService().stopAll().catch(() => {});
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
  let { vault, botToken, users } = await runSetup();

  p.intro(APP_NAME);

  // Always start web UI (dashboard or setup wizard)
  const web = startWebServer(vault, config.webPort);
  p.log.success(`Web UI at ${getBaseUrl()}`);
  if (web.setupUrl) {
    p.log.warn(`One-time setup link: ${web.setupUrl}`);
  }

  vault = await waitForVault(vault);
  ({ botToken, users } = await waitForConfiguration(vault, botToken, users));
  applyRuntimeConfig(botToken, users);

  const enabledAgentEntries = listEnabledUserAgents(readUserAgentState());
  if (enabledAgentEntries.length > 0) {
    try {
      reconcileUserAgents(getComposeProject());
    } catch (error) {
      p.log.warn(`Could not reconcile user agents: ${error instanceof Error ? error.message : error}`);
    }
  }

  return startServices(vault, botToken, users);
}

async function startServices(vault: Vault, botToken: string, users: UsersMap) {
  // MCP server
  const channel = new TelegramChannel(botToken, vault);
  registerChannel(channel);

  // Workflow engine — shared between the MCP server (for manage_workflows) and
  // the scheduler (for cron-triggered workflow instances).
  const brain = new Brain();
  const engine = createWorkflowEngine({
    brain,
    channel,
    vault,
    dataDir: config.dataDir,
    projectRoot: config.projectRoot,
  });
  engine.rehydrate();

  const mcpFactory = createMcpServerFactory(
    { channel, projectRoot: config.projectRoot, dataDir: config.dataDir, engine },
    vault,
  );
  await startMcpHttpServer(mcpFactory, config.mcpPort);
  p.log.success(`MCP server on :${config.mcpPort}`);

  setVault(vault);

  // Start services
  setTelegramConnected(true);
  startScheduler(brain, engine);

  await Promise.all([
    startBot(botToken, brain),
    ...listTelegramAgentRoutes(Object.keys(users))
      .map((route) => ({ ...route, botToken: getAgentTelegramBotToken(vault, route.userName, route.agentId) }))
      .filter((route): route is { userName: string; agentId: string; chatId?: string; botToken: string } => !!route.botToken)
      .map((route) => startBot(route.botToken, brain, route)),
  ]);
}

main().catch((error) => {
  p.log.error(`Fatal: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
