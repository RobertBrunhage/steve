/**
 * Integration test for Steve's setup flow.
 * Uses a temp directory via STEVE_DIR — never touches ~/.steve/.
 *
 * Run: pnpm test
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { strict as assert } from "node:assert";

const testDir = join(tmpdir(), `steve-test-${Date.now()}`);
process.env.STEVE_DIR = testDir;
process.env.STEVE_VAULT_DIR = join(testDir, "vault");

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    passed++;
  } catch (err: any) {
    console.log(`  \u2717 ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

function getSetCookies(res: Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

function getCookieValue(res: Response, name: string): string | null {
  for (const cookie of getSetCookies(res)) {
    if (cookie.startsWith(`${name}=`)) {
      return cookie.split(";", 1)[0];
    }
  }
  return null;
}

function extractCsrf(html: string): string | null {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  return match ? match[1] : null;
}

async function run() {
  console.log(`\n━━━ Steve Setup Tests ━━━`);
  console.log(`  STEVE_DIR: ${testDir}\n`);

  mkdirSync(testDir, { recursive: true });

  // --- Test 1: No vault, no password → returns null vault ---

  const { runSetup } = await import("../src/setup.js");
  const result = await runSetup();

  test("no vault: returns null vault", () => {
    assert.equal(result.vault, null);
  });

  test("no vault: empty botToken", () => {
    assert.equal(result.botToken, "");
  });

  test("no vault: empty users", () => {
    assert.deepEqual(result.users, {});
  });

  test("base directories created", () => {
    assert.ok(existsSync(testDir));
    assert.ok(existsSync(join(testDir, "users")));
    assert.ok(existsSync(join(testDir, "shared")));
    assert.ok(existsSync(join(testDir, "skills")));
  });

  // --- Test 2: With vault password → returns vault, sets up workspace ---

  process.env.STEVE_VAULT_PASSWORD = "test-password-123";

  // Need to re-import to get fresh module (setup caches config)
  const setup2 = await import("../src/setup.js");
  const result2 = await setup2.runSetup();

  test("with password: returns vault", () => {
    assert.ok(result2.vault !== null);
  });

  test("with password: vault is functional", () => {
    assert.ok(result2.vault!.list);
    result2.vault!.set("test/key", { value: "hello" });
    assert.equal(result2.vault!.getString("test/key"), '{"value":"hello"}');
  });

  test("keyfile created", () => {
    assert.ok(existsSync(join(testDir, "vault", "keyfile")));
  });

  test("STEVE_VAULT_PASSWORD cleared from env", () => {
    assert.equal(process.env.STEVE_VAULT_PASSWORD, undefined);
  });

  // --- Test 3: Simulate configured vault → full setup ---

  result2.vault!.set("telegram/bot_token", "test-token-123" as any);
  result2.vault!.set("steve/users", {
    testuser: {
      name: "testuser",
      channels: {
        telegram: { chat_id: "12345" },
      },
    },
  } as any);

  const result3 = await setup2.runSetup();

  test("configured: returns bot token", () => {
    assert.equal(result3.botToken, "test-token-123");
  });

  test("configured: returns users", () => {
    assert.deepEqual(result3.users, {
      testuser: {
        name: "testuser",
        channels: {
          telegram: { chat_id: "12345" },
        },
      },
    });
  });

  test("skills synced", () => {
    const skills = readdirSync(join(testDir, "skills"));
    assert.ok(skills.includes("training-coach"), "training-coach missing");
    assert.ok(skills.includes("reminders"), "reminders missing");
  });

  test("user workspace created", () => {
    const userDir = join(testDir, "users", "testuser");
    assert.ok(existsSync(userDir));
    assert.ok(existsSync(join(userDir, "SOUL.md")));
    assert.ok(existsSync(join(userDir, "AGENTS.md")));
  });

  test("memory subdirectories created", () => {
    const memDir = join(testDir, "users", "testuser", "memory");
    assert.ok(existsSync(join(memDir, "daily")));
    assert.ok(existsSync(join(memDir, "training")));
    assert.ok(existsSync(join(memDir, "nutrition")));
    assert.ok(existsSync(join(memDir, "body-measurements")));
  });

  test("profile created with current user name", () => {
    const profile = readFileSync(join(testDir, "users", "testuser", "memory", "profile.md"), "utf-8");
    assert.match(profile, /## Name/);
    assert.match(profile, /testuser/);
  });

  test("opencode config generated", () => {
    const userDir = join(testDir, "users", "testuser");
    assert.ok(existsSync(join(userDir, "opencode.json")));
    assert.ok(existsSync(join(userDir, ".opencode", "agents", "steve.md")));
  });

  test("agent instructions pin the current user name", () => {
    const agent = readFileSync(join(testDir, "users", "testuser", ".opencode", "agents", "steve.md"), "utf-8");
    assert.match(agent, /Current Steve user: testuser/);
    assert.match(agent, /always use this exact userName: testuser/);
  });

  test("users.json written", () => {
    assert.ok(existsSync(join(testDir, "users.json")));
  });

  // --- Test 4: Web auth and setup hardening ---

  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });

  const { startWebServer } = await import("../src/web/index.js");
  const { readKeyfile, Vault } = await import("../src/vault/index.js");
  const { getRuntime } = await import("../src/config.js");

  const telegramFetch: typeof fetch = async () => new Response(
    JSON.stringify({ ok: true }),
    { headers: { "content-type": "application/json" } },
  );

  const { app, setupUrl } = startWebServer(null, 0, { listen: false, telegramFetch });
  const setupToken = setupUrl ? new URL(setupUrl).searchParams.get("token") : null;

  test("web setup: setup URL includes one-time token", () => {
    assert.ok(setupToken);
  });

  const lockedSetup = await app.request("/setup");
  const lockedSetupHtml = await lockedSetup.text();
  test("web setup: setup page requires token", () => {
    assert.equal(lockedSetup.status, 403);
  });

  test("web setup: locked page explains how to find setup link", () => {
    assert.match(lockedSetupHtml, /steve setup-url/);
    assert.match(lockedSetupHtml, /steve logs/);
  });

  const bootstrapPage = await app.request(`/setup?token=${setupToken}`);
  const bootstrapCookie = getCookieValue(bootstrapPage, "steve_bootstrap");
  const bootstrapHtml = await bootstrapPage.text();
  const bootstrapCsrf = extractCsrf(bootstrapHtml);

  test("web setup: valid token issues bootstrap cookie", () => {
    assert.ok(bootstrapCookie);
    assert.ok(bootstrapCsrf);
  });

  const badSetup = await app.request("/setup", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: bootstrapCookie || "",
    },
    body: new URLSearchParams({
      password: "admin-pass-123",
      confirm_password: "admin-pass-123",
      bot_token: "telegram-token",
      user_name_0: "robert",
    }),
  });

  test("web setup: setup POST rejects missing CSRF", () => {
    assert.equal(badSetup.status, 403);
  });

  const bootstrapPage2 = await app.request(`/setup?token=${setupToken}`);
  const bootstrapCookie2 = getCookieValue(bootstrapPage2, "steve_bootstrap");
  const bootstrapCsrf2 = extractCsrf(await bootstrapPage2.text());

  const goodSetup = await app.request("/setup", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: bootstrapCookie2 || "",
    },
    body: new URLSearchParams({
      _csrf: bootstrapCsrf2 || "",
      password: "admin-pass-123",
      confirm_password: "admin-pass-123",
      bot_token: "telegram-token",
      user_name_0: "robert",
    }),
  });
  const adminCookie = getCookieValue(goodSetup, "steve_session");

  test("web setup: successful setup creates admin session", () => {
    assert.equal(goodSetup.status, 200);
    assert.ok(adminCookie);
    assert.ok(existsSync(join(testDir, "vault", "keyfile")));
  });

  const setupCompleteHtml = await goodSetup.text();
  test("web setup: completion sends the user to connect Telegram on their user page", () => {
    assert.match(setupCompleteHtml, /Connect Telegram/);
    assert.match(setupCompleteHtml, /\/users\/robert/);
  });

  const rootWithoutLogin = await app.request("/");
  test("web auth: dashboard redirects when logged out", () => {
    assert.equal(rootWithoutLogin.status, 302);
    assert.equal(rootWithoutLogin.headers.get("location"), "/login");
  });

  const loginPage = await app.request("/login");
  test("web auth: login page is available after setup", () => {
    assert.equal(loginPage.status, 200);
  });

  const badLogin = await app.request("/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: "wrong-password" }),
  });
  test("web auth: invalid password is rejected", () => {
    assert.equal(badLogin.status, 401);
  });

  const home = await app.request("/", { headers: { cookie: adminCookie || "" } });
  const homeHtml = await home.text();
  const adminCsrf = extractCsrf(homeHtml);

  test("web auth: authenticated dashboard loads", () => {
    assert.equal(home.status, 200);
    assert.ok(adminCsrf);
  });

  const secretsPage = await app.request("/secrets/list", { headers: { cookie: adminCookie || "" } });
  const secretsHtml = await secretsPage.text();
  test("web secrets: telegram bot token appears in secrets list", () => {
    assert.equal(secretsPage.status, 200);
    assert.match(secretsHtml, /telegram\/bot_token/);
  });

  const addUserWithoutCsrf = await app.request("/users/add", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: adminCookie || "",
    },
    body: new URLSearchParams({ name: "friend" }),
  });
  test("web auth: protected POST rejects missing CSRF", () => {
    assert.equal(addUserWithoutCsrf.status, 403);
  });

  const addInvalidUser = await app.request("/users/add", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: adminCookie || "",
    },
    body: new URLSearchParams({ _csrf: adminCsrf || "", name: "!!!" }),
  });
  const webVaultKey = readKeyfile(join(testDir, "vault"));
  const webVault = new Vault(join(testDir, "vault"), webVaultKey!);
  test("web auth: invalid user names are rejected", () => {
    assert.equal(addInvalidUser.status, 302);
    assert.deepEqual(webVault.get("steve/users"), {
      robert: {
        name: "robert",
        channels: {},
      },
    });
  });

  const addUser = await app.request("/users/add", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: adminCookie || "",
    },
    body: new URLSearchParams({ _csrf: adminCsrf || "", name: "friend" }),
  });
  const usersAfterAdd = new Vault(join(testDir, "vault"), webVaultKey!);

  test("web users: add user creates the Steve user before linking channels", () => {
    assert.equal(addUser.status, 302);
    assert.equal(addUser.headers.get("location"), "/users/friend");
    assert.deepEqual(usersAfterAdd.get("steve/users"), {
      robert: {
        name: "robert",
        channels: {},
      },
      friend: {
        name: "friend",
        channels: {},
      },
    });
  });

  const friendPage = await app.request("/users/friend", {
    headers: { cookie: adminCookie || "" },
  });
  const friendPageHtml = await friendPage.text();

  test("web users: user page is where Telegram gets connected", () => {
    assert.equal(friendPage.status, 200);
    assert.match(friendPageHtml, /Connections/);
    assert.match(friendPageHtml, /Connect Telegram/);
  });

  const connectTelegram = await app.request("/users/friend/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: adminCookie || "",
    },
    body: new URLSearchParams({ _csrf: adminCsrf || "", telegram_id: "67890" }),
  });
  const usersAfterTelegramConnect = new Vault(join(testDir, "vault"), webVaultKey!);

  test("web users: Telegram can be linked from the user page", () => {
    assert.equal(connectTelegram.status, 302);
    assert.equal(connectTelegram.headers.get("location"), "/users/friend");
    assert.deepEqual(usersAfterTelegramConnect.get("steve/users"), {
      robert: {
        name: "robert",
        channels: {},
      },
      friend: {
        name: "friend",
        channels: {
          telegram: { chat_id: "67890" },
        },
      },
    });
  });

  test("web users: linking Telegram refreshes runtime routing immediately", () => {
    assert.deepEqual(getRuntime().allowedUserIds.sort((a, b) => a - b), [67890]);
    assert.equal(getRuntime().users.friend?.channels.telegram?.chat_id, "67890");
  });

  const editTelegram = await app.request("/secrets/telegram%2Fbot_token/edit", {
    headers: { cookie: adminCookie || "" },
  });
  const editTelegramHtml = await editTelegram.text();

  test("web secrets: telegram bot token can be edited like a normal secret", () => {
    assert.equal(editTelegram.status, 200);
    assert.match(editTelegramHtml, /Edit: <code class="text-blue-400">telegram\/bot_token<\/code>/);
  });

  test("web secrets: edit form does not prefill secret values", () => {
    assert.doesNotMatch(editTelegramHtml, /telegram-token/);
    assert.match(editTelegramHtml, /Leave blank to keep current value/);
  });

  const updateTelegram = await app.request("/secrets/telegram%2Fbot_token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: adminCookie || "",
    },
    body: new URLSearchParams({ _csrf: adminCsrf || "", field_name_0: "bot_token", field_value_0: "updated-token" }),
  });
  const updatedVault = new Vault(join(testDir, "vault"), webVaultKey!);

  test("web secrets: telegram token can be updated from secrets page", () => {
    assert.equal(updateTelegram.status, 302);
    assert.equal(updateTelegram.headers.get("location"), "/");
    assert.equal(updatedVault.getString("telegram/bot_token"), "updated-token");
  });

  const keepTelegram = await app.request("/secrets/telegram%2Fbot_token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: adminCookie || "",
    },
    body: new URLSearchParams({ _csrf: adminCsrf || "", field_name_0: "bot_token", field_value_0: "" }),
  });
  const preservedVault = new Vault(join(testDir, "vault"), webVaultKey!);

  test("web secrets: blank edit keeps the current secret value", () => {
    assert.equal(keepTelegram.status, 302);
    assert.equal(preservedVault.getString("telegram/bot_token"), "updated-token");
  });

  const setupLockedAfterInit = await app.request(`/setup?token=${setupToken}`);
  test("web auth: setup link is disabled after initialization", () => {
    assert.equal(setupLockedAfterInit.status, 302);
    assert.equal(setupLockedAfterInit.headers.get("location"), "/login");
  });

  // --- Test 5: Restored data only needs dashboard password ---

  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });

  const { initializeVault } = await import("../src/vault/index.js");
  const restoredKey = initializeVault(join(testDir, "vault"), "restore-password-123");
  const restoredVault = new Vault(join(testDir, "vault"), restoredKey);
  restoredVault.set("telegram/bot_token", "restored-bot-token" as any);
  restoredVault.set("steve/users", {
    robert: {
      name: "robert",
      channels: {},
    },
  } as any);

  const { startWebServer: startRestoredWebServer } = await import("../src/web/index.js");
  const restoredWeb = startRestoredWebServer(restoredVault, 0, { listen: false, telegramFetch });
  const restoredSetupToken = restoredWeb.setupUrl ? new URL(restoredWeb.setupUrl).searchParams.get("token") : null;
  const restoredSetupPage = await restoredWeb.app.request(`/setup?token=${restoredSetupToken}`);
  const restoredSetupCookie = getCookieValue(restoredSetupPage, "steve_bootstrap");
  const restoredSetupHtml = await restoredSetupPage.text();
  const restoredCsrf = extractCsrf(restoredSetupHtml);

  test("restored setup: only asks for the missing dashboard password", () => {
    assert.equal(restoredSetupPage.status, 200);
    assert.match(restoredSetupHtml, /Your backup is restored/);
    assert.doesNotMatch(restoredSetupHtml, /name="bot_token"/);
    assert.doesNotMatch(restoredSetupHtml, /name="user_name_0"/);
  });

  const restoredSetupPost = await restoredWeb.app.request("/setup", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: restoredSetupCookie || "",
    },
    body: new URLSearchParams({
      _csrf: restoredCsrf || "",
      password: "new-dashboard-pass",
      confirm_password: "new-dashboard-pass",
    }),
  });
  const restoredVaultAfter = new Vault(join(testDir, "vault"), restoredKey);

  test("restored setup: preserves restored data and only adds dashboard auth", () => {
    assert.equal(restoredSetupPost.status, 200);
    assert.ok(restoredVaultAfter.get("steve/admin_auth"));
    assert.equal(restoredVaultAfter.getString("telegram/bot_token"), "restored-bot-token");
    assert.deepEqual(restoredVaultAfter.get("steve/users"), {
      robert: {
        name: "robert",
        channels: {},
      },
    });
  });

  // Cleanup
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {}

  console.log(`\n━━━ Results: ${passed} passed, ${failed} failed ━━━\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Test runner error:", err);
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {}
  process.exit(1);
});
