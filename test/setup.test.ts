/**
 * Integration test for Steve's setup flow.
 * Uses a temp directory via STEVE_DIR — never touches ~/.steve/.
 *
 * Run: pnpm test
 */

import {
  existsSync,
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
  result2.vault!.set("steve/users", { "12345": "TestUser" } as any);

  const result3 = await setup2.runSetup();

  test("configured: returns bot token", () => {
    assert.equal(result3.botToken, "test-token-123");
  });

  test("configured: returns users", () => {
    assert.deepEqual(result3.users, { "12345": "TestUser" });
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

  test("opencode config generated", () => {
    const userDir = join(testDir, "users", "testuser");
    assert.ok(existsSync(join(userDir, "opencode.json")));
    assert.ok(existsSync(join(userDir, ".opencode", "agents", "steve.md")));
  });

  test("users.json written", () => {
    assert.ok(existsSync(join(testDir, "users.json")));
  });

  // --- Test 4: Web auth and setup hardening ---

  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });

  const { startWebServer } = await import("../src/web/index.js");
  const { readKeyfile, Vault } = await import("../src/vault/index.js");

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
  test("web setup: setup page requires token", () => {
    assert.equal(lockedSetup.status, 403);
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
      user_id_0: "12345",
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
      user_id_0: "12345",
    }),
  });
  const adminCookie = getCookieValue(goodSetup, "steve_session");

  test("web setup: successful setup creates admin session", () => {
    assert.equal(goodSetup.status, 200);
    assert.ok(adminCookie);
    assert.ok(existsSync(join(testDir, "vault", "keyfile")));
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

  const addUserWithoutCsrf = await app.request("/users/add", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: adminCookie || "",
    },
    body: new URLSearchParams({ name: "friend", telegram_id: "67890" }),
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
    body: new URLSearchParams({ _csrf: adminCsrf || "", name: "!!!", telegram_id: "67890" }),
  });
  const webVaultKey = readKeyfile(join(testDir, "vault"));
  const webVault = new Vault(join(testDir, "vault"), webVaultKey!);
  test("web auth: invalid user names are rejected", () => {
    assert.equal(addInvalidUser.status, 302);
    assert.deepEqual(webVault.get("steve/users"), { "12345": "robert" });
  });

  const setupLockedAfterInit = await app.request(`/setup?token=${setupToken}`);
  test("web auth: setup link is disabled after initialization", () => {
    assert.equal(setupLockedAfterInit.status, 302);
    assert.equal(setupLockedAfterInit.headers.get("location"), "/login");
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
