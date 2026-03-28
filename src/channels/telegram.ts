import type { Channel, SendResult } from "./index.js";
import { getRuntime } from "../config.js";
import { getTelegramChatId } from "../users.js";

export class TelegramChannel implements Channel {
  readonly name = "telegram";

  constructor(private botToken: string) {}

  private getChatId(userName: string): string | null {
    return getTelegramChatId(getRuntime().users, userName);
  }

  private getBotToken(): string {
    try {
      return getRuntime().botToken || this.botToken;
    } catch {
      return this.botToken;
    }
  }

  async sendMessage(userName: string, text: string, options?: { buttons?: string[][] }): Promise<SendResult> {
    const chatId = this.getChatId(userName);
    if (!chatId) return { ok: false, error: `Unknown user "${userName}"` };

    // Build inline keyboard if buttons provided
    let replyMarkup: object | undefined;
    if (options?.buttons?.length) {
      replyMarkup = {
        inline_keyboard: options.buttons.map((row) =>
          row.map((label) => ({ text: label, callback_data: label })),
        ),
      };
    }

    // Try HTML parse mode first, fall back to plain text
    let res = await fetch(
      `https://api.telegram.org/bot${this.getBotToken()}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        }),
      },
    );

    if (!res.ok) {
      res = await fetch(
        `https://api.telegram.org/bot${this.getBotToken()}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
          }),
        },
      );
    }

    const data = await res.json() as { ok: boolean; description?: string; result?: { message_id: number } };
    return {
      ok: data.ok,
      messageId: data.result?.message_id?.toString(),
      error: data.description,
    };
  }

  async editMessage(userName: string, messageId: string, text: string): Promise<SendResult> {
    const chatId = this.getChatId(userName);
    if (!chatId) return { ok: false, error: `Unknown user "${userName}"` };

    const res = await fetch(
      `https://api.telegram.org/bot${this.getBotToken()}/editMessageText`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, message_id: Number(messageId), text, parse_mode: "HTML" }),
      },
    );

    const data = await res.json() as { ok: boolean; description?: string };
    return { ok: data.ok, messageId, error: data.description };
  }
}
