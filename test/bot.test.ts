import { strict as assert } from "node:assert";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function main() {
  const tempDir = mkdtempSync(join(tmpdir(), "kellix-bot-test-"));
  const originalFetch = globalThis.fetch;

  process.env.KELLIX_DIR = tempDir;
  process.env.KELLIX_VAULT_DIR = join(tempDir, "vault");

  try {
    const { setRuntimeConfig } = await import("../src/config.js");
    const { registerMessageHandler } = await import("../src/bot/message-handler.js");

    setRuntimeConfig({
      botToken: "test-bot-token",
      users: {
        robert: {
          name: "robert",
          channels: { telegram: { chat_id: "123" } },
        },
      },
      allowedUserIds: [123],
    });

    const calls: Array<{ userMessage: string; userName: string; files?: string[] }> = [];
    const brain = {
      think: async (userMessage: string, userName: string, files?: string[]) => {
        calls.push({ userMessage, userName, files });
      },
    };

    const handlers = new Map<string, (ctx: any) => Promise<void> | void>();
    const bot = {
      on(event: string, handler: (ctx: any) => Promise<void> | void) {
        handlers.set(event, handler);
      },
    };

    registerMessageHandler(bot as any, brain as any);

    const photoHandler = handlers.get("message:photo");
    assert.ok(photoHandler, "message:photo handler should be registered");

    globalThis.fetch = async () => {
      return new Response(Uint8Array.from([1, 2, 3]), { status: 200 });
    };

    const replies: string[] = [];
    const makePhotoContext = (filePath: string, caption?: string) => ({
      from: { id: 123 },
      chat: { id: 123 },
      message: {
        photo: [{ file_id: `${filePath}-thumb` }, { file_id: filePath }],
        ...(caption ? { caption } : {}),
        media_group_id: "album-1",
      },
      api: {
        getFile: async (fileId: string) => ({ file_path: fileId }),
      },
      reply: async (text: string) => {
        replies.push(text);
      },
      replyWithChatAction: async () => {},
    });

    await photoHandler!(makePhotoContext("album-1.jpg", "Snack is 2 out of 6 of these"));
    await photoHandler!(makePhotoContext("album-2.jpg"));

    await new Promise((resolve) => setTimeout(resolve, 1200));

    const files = calls[0]?.files ?? [];
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.userName, "robert");
    assert.equal(files.length, 2);
    assert.equal(new Set(files).size, 2);
    assert.ok(files.every((file) => file.startsWith("/data/tmp/photo-") && file.endsWith(".jpg")));
    assert.match(calls[0]?.userMessage ?? "", /^Snack is 2 out of 6 of these\n\nAttached file paths:\n- \/data\/tmp\/photo-.*\.jpg\n- \/data\/tmp\/photo-.*\.jpg$/);
    assert.deepEqual(replies, []);
    assert.deepEqual(readdirSync(join(tempDir, "users", "robert", "tmp")), []);

    console.log("Bot photo grouping tests passed");
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
