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
