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

  result2.vault!.set("system/telegram/bot_token", "test-token-123" as any);
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

  test("default skills copied into each user workspace", () => {
    const skills = readdirSync(join(testDir, "users", "testuser", "skills"));
    assert.ok(skills.includes("training-coach"), "training-coach missing");
    assert.ok(skills.includes("reminders"), "reminders missing");
  });

  test("user workspace created", () => {
    const userDir = join(testDir, "users", "testuser");
    assert.ok(existsSync(userDir));
    assert.ok(existsSync(join(userDir, "SOUL.md")));
    assert.ok(existsSync(join(userDir, "AGENTS.md")));
    assert.ok(existsSync(join(userDir, "skills")));
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
  const { appendUserActivity } = await import("../src/activity.js");
  const { loadUserJobs, saveUserJobs } = await import("../src/scheduler.js");

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

  const settingsPage = await app.request("/settings", { headers: { cookie: adminCookie || "" } });
  const settingsHtml = await settingsPage.text();
  test("web settings: system secrets page loads", () => {
    assert.equal(settingsPage.status, 200);
    assert.match(settingsHtml, /Save Telegram Token/);
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

  test("web users: overview page focuses on connection and activity", () => {
    assert.equal(friendPage.status, 200);
    assert.match(friendPageHtml, /Connections/);
    assert.match(friendPageHtml, /Connect Telegram/);
    assert.match(friendPageHtml, /Recent Activity/);
    assert.match(friendPageHtml, /href="\/users\/friend\/integrations"/);
  });

  saveUserJobs("robert", [{
    id: "doctor-checkin",
    name: "Doctor Check-In",
    prompt: "Ask if I booked the appointment",
    at: "2030-01-01T10:00:00.000Z",
    disabled: true,
    lastRunAt: "2029-12-20T09:00:00.000Z",
    lastStatus: "error",
    lastError: "Needs confirmation",
  }]);
  saveUserJobs("friend", [{
    id: "weekly-review",
    name: "Weekly Review",
    prompt: "Ask for a weekly review",
    cron: "0 9 * * 1",
  }]);

  const jobsPage = await app.request("/jobs", { headers: { cookie: adminCookie || "" } });
  const jobsHtml = await jobsPage.text();

  test("web jobs: jobs page shows scheduled jobs across users", () => {
    assert.equal(jobsPage.status, 200);
    assert.match(jobsHtml, /Jobs & Routines/);
    assert.match(jobsHtml, /Doctor Check-In/);
    assert.match(jobsHtml, /Weekly Review/);
    assert.match(jobsHtml, /Needs confirmation/);
    assert.match(jobsHtml, /Resume/);
    assert.match(jobsHtml, /Pause/);
  });

  const pauseJob = await app.request("/jobs/toggle", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: adminCookie || "",
    },
    body: new URLSearchParams({ _csrf: adminCsrf || "", user: "friend", id: "weekly-review", disabled: "true" }),
  });

  test("web jobs: jobs can be paused from the jobs page", () => {
    assert.equal(pauseJob.status, 302);
    assert.equal(pauseJob.headers.get("location"), "/jobs");
    assert.equal(loadUserJobs("friend")[0]?.disabled, true);
  });

  const deleteJob = await app.request("/jobs/delete", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: adminCookie || "",
    },
    body: new URLSearchParams({ _csrf: adminCsrf || "", user: "robert", id: "doctor-checkin" }),
  });

  test("web jobs: jobs can be deleted from the jobs page", () => {
    assert.equal(deleteJob.status, 302);
    assert.equal(deleteJob.headers.get("location"), "/jobs");
    assert.equal(loadUserJobs("robert").length, 0);
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

  const updateTelegram = await app.request("/settings/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: adminCookie || "",
    },
    body: new URLSearchParams({ _csrf: adminCsrf || "", bot_token: "updated-token" }),
  });
  const updatedVault = new Vault(join(testDir, "vault"), webVaultKey!);

  test("web settings: telegram token can be updated from settings page", () => {
    assert.equal(updateTelegram.status, 302);
    assert.equal(updateTelegram.headers.get("location"), "/settings");
    assert.equal(updatedVault.getString("system/telegram/bot_token"), "updated-token");
  });

  const keepTelegram = await app.request("/settings/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: adminCookie || "",
    },
    body: new URLSearchParams({ _csrf: adminCsrf || "", bot_token: "" }),
  });
  const preservedVault = new Vault(join(testDir, "vault"), webVaultKey!);

  test("web settings: blank edit keeps the current telegram token", () => {
    assert.equal(keepTelegram.status, 302);
    assert.equal(preservedVault.getString("system/telegram/bot_token"), "updated-token");
  });

  const integrationsPage = await app.request("/users/friend/integrations", {
    headers: { cookie: adminCookie || "" },
  });
  const integrationsHtml = await integrationsPage.text();

  test("web users: integrations live on their own subpage", () => {
    assert.equal(integrationsPage.status, 200);
    assert.match(integrationsHtml, /Secrets & Integrations/);
    assert.match(integrationsHtml, /Add Integration/);
    assert.match(integrationsHtml, /When Steve asks for app credentials in Telegram, add them here/);
  });

  const newSecretPage = await app.request("/users/friend/integrations/new", {
    headers: { cookie: adminCookie || "" },
  });
  const newSecretHtml = await newSecretPage.text();

  test("web users: user secret form lives under the user page", () => {
    assert.equal(newSecretPage.status, 200);
    assert.match(newSecretHtml, /Add Integration for friend/);
  });

  const createUserSecret = await app.request("/users/friend/integrations", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: adminCookie || "",
    },
    body: new URLSearchParams({
      _csrf: adminCsrf || "",
      integration: "withings",
      field_name_0: "client_id",
      field_value_0: "client-id-123",
      field_name_1: "client_secret",
      field_value_1: "client-secret-456",
    }),
  });
  const userSecretVault = new Vault(join(testDir, "vault"), webVaultKey!);

  test("web users: user integrations save under the user page", () => {
    assert.equal(createUserSecret.status, 302);
    assert.equal(createUserSecret.headers.get("location"), "/users/friend/integrations");
    assert.deepEqual(userSecretVault.get("users/friend/withings/app"), {
      client_id: "client-id-123",
      client_secret: "client-secret-456",
    });
  });

  appendUserActivity(testDir, {
    timestamp: "2030-01-02T08:00:00.000Z",
    userName: "friend",
    type: "job",
    status: "ok",
    summary: "Completed job: Weekly Review",
  });
  appendUserActivity(testDir, {
    timestamp: "2030-01-02T08:30:00.000Z",
    userName: "friend",
    type: "script",
    status: "info",
    summary: "Script ran: withings/setup.sh",
  });

  const friendPageAfterSecret = await app.request("/users/friend/integrations", {
    headers: { cookie: adminCookie || "" },
  });
  const friendPageAfterSecretHtml = await friendPageAfterSecret.text();

  test("web users: integrations are shown on the integrations page", () => {
    assert.equal(friendPageAfterSecret.status, 200);
    assert.match(friendPageAfterSecretHtml, /Withings/);
  });

  const friendOverviewAfterActivity = await app.request("/users/friend", {
    headers: { cookie: adminCookie || "" },
  });
  const friendOverviewAfterActivityHtml = await friendOverviewAfterActivity.text();

  test("web users: recent activity is shown on the overview page", () => {
    assert.equal(friendOverviewAfterActivity.status, 200);
    assert.match(friendOverviewAfterActivityHtml, /Completed job: Weekly Review/);
    assert.match(friendOverviewAfterActivityHtml, /Script ran: withings\/setup.sh/);
  });

  const editUserSecret = await app.request("/users/friend/integrations/withings/edit", {
    headers: { cookie: adminCookie || "" },
  });
  const editUserSecretHtml = await editUserSecret.text();

  test("web users: integration edit form does not prefill secret values", () => {
    assert.equal(editUserSecret.status, 200);
    assert.doesNotMatch(editUserSecretHtml, /client-id-123/);
    assert.match(editUserSecretHtml, /Leave blank to keep current value/);
  });

  const updateUserSecret = await app.request("/users/friend/integrations/withings", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: adminCookie || "",
    },
    body: new URLSearchParams({
      _csrf: adminCsrf || "",
      field_name_0: "client_id",
      field_value_0: "updated-client-id",
      field_name_1: "client_secret",
      field_value_1: "",
    }),
  });
  const updatedUserSecretVault = new Vault(join(testDir, "vault"), webVaultKey!);

  test("web users: integration edits preserve hidden values when blank", () => {
    assert.equal(updateUserSecret.status, 302);
    assert.deepEqual(updatedUserSecretVault.get("users/friend/withings/app"), {
      client_id: "updated-client-id",
      client_secret: "client-secret-456",
    });
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
  restoredVault.set("system/telegram/bot_token", "restored-bot-token" as any);
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
    assert.equal(restoredVaultAfter.getString("system/telegram/bot_token"), "restored-bot-token");
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
