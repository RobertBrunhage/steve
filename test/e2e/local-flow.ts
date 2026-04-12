import { strict as assert } from "node:assert";
import {
  CookieJar,
  assertIncludes,
  cleanupTestEnv,
  createTestEnv,
  downLocalStack,
  extractCsrf,
  requestText,
  runCommand,
  sleep,
  startTelegramMockServer,
  waitFor,
} from "./helpers.js";

async function main() {
  const cwd = process.cwd();
  const testEnv = createTestEnv(cwd, "local-flow");
  const telegram = await startTelegramMockServer(testEnv.telegramPort, testEnv.telegramToken);
  const jar = new CookieJar();

  try {
    await runCommand("./kellix", ["up"], { cwd, env: testEnv.env, timeoutMs: 600000 });
    await waitFor(`http://127.0.0.1:${testEnv.webPort}/setup`);

    const setupUrlResult = await runCommand("./kellix", ["setup-url"], {
      cwd,
      env: testEnv.env,
      capture: true,
      timeoutMs: 30000,
    });
    assert.equal(setupUrlResult.code, 0);
    const setupUrlMatch = setupUrlResult.stdout.match(/http:\/\/[^\s]+/);
    assert.ok(setupUrlMatch, "Expected setup URL in ./kellix setup-url output");
    const setupUrl = new URL(setupUrlMatch[0]);
    setupUrl.hostname = "127.0.0.1";

    const setupPage = await requestText(setupUrl.toString(), { jar });
    assert.equal(setupPage.res.status, 200);
    const setupCsrf = extractCsrf(setupPage.text);

    const setupPost = await requestText(`http://127.0.0.1:${testEnv.webPort}/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: setupCsrf,
        password: "admin-pass-123",
        confirm_password: "admin-pass-123",
        bot_token: testEnv.telegramToken,
        user_name_0: "Robert",
      }),
      jar,
    });
    assert.equal(setupPost.res.status, 200);
    assertIncludes(setupPost.text, "Connect Telegram");

    let userPage = await requestText(`http://127.0.0.1:${testEnv.webPort}/users/robert`, { jar });
    const userPageStart = Date.now();
    while (userPage.res.status !== 200 && Date.now() - userPageStart < 30000) {
      await sleep(1000);
      userPage = await requestText(`http://127.0.0.1:${testEnv.webPort}/users/robert`, { jar });
    }
    assert.equal(userPage.res.status, 200);
    const userCsrf = extractCsrf(userPage.text);

    const connectTelegram = await requestText(`http://127.0.0.1:${testEnv.webPort}/users/robert/telegram`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: userCsrf, telegram_id: "12345" }),
      jar,
    });
    assert.equal(connectTelegram.res.status, 302);

    await sleep(4000);
    await telegram.pushTextMessage(12345, "hello from e2e");

    const started = Date.now();
    let sentMessages: any[] = [];
    while (Date.now() - started < 60000) {
      sentMessages = await telegram.getSentMessages();
      if (sentMessages.some((msg) => msg.method === "sendMessage" && msg.body.text.includes("Something went wrong on my end"))) {
        break;
      }
      await sleep(1000);
    }

    const fallback = sentMessages.find((msg) => msg.method === "sendMessage" && msg.body.text.includes("Something went wrong on my end"));
    assert.ok(fallback, "Expected fallback Telegram reply after bot received a mocked message");
    assert.equal(String(fallback.body.chat_id), "12345");

    console.log("E2E local flow passed");
  } finally {
    await telegram.close();
    await downLocalStack(cwd, testEnv);
    cleanupTestEnv(testEnv);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
