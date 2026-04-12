import { readFileSync } from "node:fs";
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
  sleep,
  startTelegramMockServer,
  waitFor,
} from "./helpers.js";

async function login(testEnv: ReturnType<typeof createTestEnv>, jar: CookieJar) {
  const loginPage = await requestText(`http://127.0.0.1:${testEnv.webPort}/login`, { jar });
  assert.equal(loginPage.res.status, 200);
  const loginPost = await requestText(`http://127.0.0.1:${testEnv.webPort}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: "agent-pass-123" }),
    jar,
  });
  assert.equal(loginPost.res.status, 302);
}

async function waitForPsEntry(cwd: string, testEnv: ReturnType<typeof createTestEnv>, value: string, present: boolean) {
  const started = Date.now();
  while (Date.now() - started < 120000) {
    const result = await runCommand("./kellix", ["ps"], {
      cwd,
      env: testEnv.env,
      capture: true,
      timeoutMs: 30000,
    });
    assert.equal(result.code, 0);
    const hasEntry = result.stdout.includes(value);
    if (hasEntry === present) {
      return result.stdout;
    }
    await sleep(2000);
  }
  throw new Error(`Timed out waiting for ./kellix ps to ${present ? "include" : "exclude"} ${value}`);
}

async function waitForUserStatus(testEnv: ReturnType<typeof createTestEnv>, jar: CookieJar, expected: string) {
  const started = Date.now();
  while (Date.now() - started < 120000) {
    const page = await requestText(`http://127.0.0.1:${testEnv.webPort}/users/robert`, { jar });
    if (page.res.status === 200 && page.text.includes(expected)) {
      return page.text;
    }
    await sleep(2000);
  }
  throw new Error(`Timed out waiting for user page to include ${expected}`);
}

async function main() {
  const cwd = process.cwd();
  const testEnv = createTestEnv(cwd, "agents-flow");
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
    if (!setupUrlMatch) {
      throw new Error("Expected setup URL in ./kellix setup-url output");
    }
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
        password: "agent-pass-123",
        confirm_password: "agent-pass-123",
        bot_token: testEnv.telegramToken,
        user_name_0: "Robert",
      }),
      jar,
    });
    assert.equal(setupPost.res.status, 200);

    let userPage = await requestText(`http://127.0.0.1:${testEnv.webPort}/users/robert`, { jar });
    const userPageStarted = Date.now();
    while (userPage.res.status !== 200 && Date.now() - userPageStarted < 30000) {
      await sleep(1000);
      userPage = await requestText(`http://127.0.0.1:${testEnv.webPort}/users/robert`, { jar });
    }
    assert.equal(userPage.res.status, 200);
    let userCsrf = extractCsrf(userPage.text);

    const startAgent = await requestText(`http://127.0.0.1:${testEnv.webPort}/users/robert/start`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: userCsrf }),
      jar,
    });
    assert.equal(startAgent.res.status, 302);

    await waitForPsEntry(cwd, testEnv, "opencode-robert", true);
    const agentsComposePath = join(testEnv.localEnvDir, "agents.compose.yml");
    assert.ok(readFileSync(agentsComposePath, "utf-8").includes("opencode-robert"));
    await waitForUserStatus(testEnv, jar, "Running");

    await runCommand("./kellix", ["down"], { cwd, env: testEnv.env, timeoutMs: 120000 });
    await runCommand("./kellix", ["up"], { cwd, env: testEnv.env, timeoutMs: 600000 });
    await waitFor(`http://127.0.0.1:${testEnv.webPort}/login`);
    await login(testEnv, jar);
    await waitForPsEntry(cwd, testEnv, "opencode-robert", true);
    await waitForUserStatus(testEnv, jar, "Running");
    userPage = await requestText(`http://127.0.0.1:${testEnv.webPort}/users/robert`, { jar });
    assert.equal(userPage.res.status, 200);
    userCsrf = extractCsrf(userPage.text);

    const stopAgent = await requestText(`http://127.0.0.1:${testEnv.webPort}/users/robert/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: userCsrf }),
      jar,
    });
    assert.equal(stopAgent.res.status, 302);

    await waitForPsEntry(cwd, testEnv, "opencode-robert", false);
    assert.ok(!readFileSync(agentsComposePath, "utf-8").includes("opencode-robert"));
    await waitForUserStatus(testEnv, jar, "Paused");

    await runCommand("./kellix", ["down"], { cwd, env: testEnv.env, timeoutMs: 120000 });
    await runCommand("./kellix", ["up"], { cwd, env: testEnv.env, timeoutMs: 600000 });
    await waitFor(`http://127.0.0.1:${testEnv.webPort}/login`);
    await login(testEnv, jar);
    await waitForPsEntry(cwd, testEnv, "opencode-robert", false);
    await waitForUserStatus(testEnv, jar, "Paused");
    userPage = await requestText(`http://127.0.0.1:${testEnv.webPort}/users/robert`, { jar });
    assert.equal(userPage.res.status, 200);

    console.log("E2E agents flow passed");
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
