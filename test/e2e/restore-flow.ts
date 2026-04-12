import { join } from "node:path";
import { strict as assert } from "node:assert";
import {
  CookieJar,
  cleanupTestEnv,
  createTestEnv,
  downLocalStack,
  extractCsrf,
  requestText,
  runCommand,
  startTelegramMockServer,
  waitFor,
} from "./helpers.js";

async function main() {
  const cwd = process.cwd();
  const testEnv = createTestEnv(cwd, "restore");
  const telegram = await startTelegramMockServer(testEnv.telegramPort, testEnv.telegramToken);
  const jar = new CookieJar();
  const backupFile = join(testEnv.backupDir, "kellix-e2e-backup.enc");

  try {
    await runCommand("./kellix", ["up"], { cwd, env: testEnv.env, timeoutMs: 600000 });
    await waitFor(`http://127.0.0.1:${testEnv.webPort}/setup`);

    const setupUrlResult = await runCommand("./kellix", ["setup-url"], { cwd, env: testEnv.env, capture: true });
    const setupUrlMatch = setupUrlResult.stdout.match(/http:\/\/[^\s]+/);
    assert.ok(setupUrlMatch, "Expected setup URL in ./kellix setup-url output");
    const setupUrl = new URL(setupUrlMatch[0]);
    setupUrl.hostname = "127.0.0.1";
    const setupPage = await requestText(setupUrl.toString(), { jar });
    const setupCsrf = extractCsrf(setupPage.text);

    const setupPost = await requestText(`http://127.0.0.1:${testEnv.webPort}/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: setupCsrf,
        password: "restore-pass-123",
        confirm_password: "restore-pass-123",
        bot_token: testEnv.telegramToken,
        user_name_0: "Robert",
      }),
      jar,
    });
    assert.equal(setupPost.res.status, 200);

    const secretsPage = await requestText(`http://127.0.0.1:${testEnv.webPort}/users/robert/integrations/new`, { jar });
    const secretsCsrf = extractCsrf(secretsPage.text);
    const createSecret = await requestText(`http://127.0.0.1:${testEnv.webPort}/users/robert/integrations`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: secretsCsrf,
        integration: "test-service",
        field_name_0: "api_key",
        field_value_0: "secret-value",
      }),
      jar,
    });
    assert.equal(createSecret.res.status, 302);

    await runCommand("./kellix", ["backup", backupFile], { cwd, env: testEnv.env, timeoutMs: 120000 });
    await downLocalStack(cwd, testEnv);

    await runCommand("./kellix", ["restore", backupFile], { cwd, env: testEnv.env, timeoutMs: 120000 });
    await runCommand("./kellix", ["up"], { cwd, env: testEnv.env, timeoutMs: 120000 });
    await waitFor(`http://127.0.0.1:${testEnv.webPort}/login`);

    const loginPage = await requestText(`http://127.0.0.1:${testEnv.webPort}/login`, { jar });
    const loginPost = await requestText(`http://127.0.0.1:${testEnv.webPort}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "restore-pass-123" }),
      jar,
    });
    assert.equal(loginPage.res.status, 200);
    assert.equal(loginPost.res.status, 302);

    const restoredSecrets = await requestText(`http://127.0.0.1:${testEnv.webPort}/users/robert/integrations`, { jar });
    assert.equal(restoredSecrets.res.status, 200);
    assert.ok(restoredSecrets.text.includes("Test Service"));

    console.log("E2E restore flow passed");
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
