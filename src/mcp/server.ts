import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// Read config from the working directory (which is ~/.steve/ when opencode runs)
const configPath = join(process.cwd(), "config.json");
const config = JSON.parse(readFileSync(configPath, "utf-8"));
const botToken: string = config.telegram_bot_token;
const users: Record<string, string> = config.users; // { "telegramId": "Name" }

function getChatId(userName: string): string | null {
  for (const [id, name] of Object.entries(users)) {
    if (name.toLowerCase() === userName.toLowerCase()) return id;
  }
  return null;
}

async function sendTelegram(
  chatId: string,
  text: string,
): Promise<{ ok: boolean; description?: string }> {
  // Try Markdown first, fall back to plain text
  let res = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    },
  );

  if (!res.ok) {
    res = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
      },
    );
  }

  return res.json();
}

const server = new McpServer({
  name: "steve-telegram",
  version: "1.0.0",
});

server.registerTool("send_telegram_message", {
  description:
    "Send a message to a user on Telegram. Use this to respond to users.",
  inputSchema: {
    userName: z.string().describe("The name of the user to send the message to"),
    message: z.string().describe("The message text to send (supports Markdown)"),
  },
}, async ({ userName, message }) => {
  const chatId = getChatId(userName);
  if (!chatId) {
    return {
      content: [{ type: "text", text: `Error: Unknown user "${userName}"` }],
      isError: true,
    };
  }

  const result = await sendTelegram(chatId, message);
  if (!result.ok) {
    return {
      content: [
        {
          type: "text",
          text: `Error: Telegram API returned: ${result.description || "unknown error"}`,
        },
      ],
      isError: true,
    };
  }

  return {
    content: [{ type: "text", text: `Message sent to ${userName}` }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
