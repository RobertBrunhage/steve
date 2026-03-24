/**
 * Integration test for Steve's setup flow.
 * Uses a temp directory via STEVE_DIR - never touches ~/.steve/.
 *
 * Run: pnpm test
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { strict as assert } from "node:assert";

// Set STEVE_DIR to a temp directory BEFORE importing anything else
const testDir = join(tmpdir(), `steve-test-${Date.now()}`);
process.env.STEVE_DIR = testDir;

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

  // Seed config to skip interactive prompts
  mkdirSync(testDir, { recursive: true });
  writeFileSync(
    join(testDir, "config.json"),
    JSON.stringify({
      telegram_bot_token: "test-token-123",
      users: { "12345": "TestUser" },
      model: "sonnet",
    }),
    "utf-8",
  );

  // Import setup (picks up STEVE_DIR from env)
  const { runSetup } = await import("../src/setup.js");
  const result = await runSetup();

  test("setup returns true", () => {
    assert.equal(result, true);
  });

  test("data directory exists", () => {
    assert.ok(existsSync(testDir));
  });

  test("config.json exists and is valid", () => {
    const configPath = join(testDir, "config.json");
    assert.ok(existsSync(configPath));
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    assert.equal(config.telegram_bot_token, "test-token-123");
    assert.deepEqual(config.users, { "12345": "TestUser" });
    assert.equal(config.model, "sonnet");
  });

  test("SOUL.md copied", () => {
    assert.ok(existsSync(join(testDir, "SOUL.md")));
    const content = readFileSync(join(testDir, "SOUL.md"), "utf-8");
    assert.ok(content.includes("Steve"));
  });

  test("skills/ directory exists", () => {
    assert.ok(existsSync(join(testDir, "skills")));
  });

  test("default skills copied", () => {
    const skills = readdirSync(join(testDir, "skills"));
    assert.ok(skills.includes("training-coach"), "training-coach missing");
    assert.ok(skills.includes("reminders"), "reminders missing");
    assert.ok(skills.includes("TEMPLATE.md"), "TEMPLATE.md missing");
  });

  test("skill directories have SKILL.md", () => {
    assert.ok(existsSync(join(testDir, "skills/training-coach/SKILL.md")));
    assert.ok(existsSync(join(testDir, "skills/reminders/SKILL.md")));
  });

  test("memory/ directory exists", () => {
    assert.ok(existsSync(join(testDir, "memory")));
  });

  test("memory/shared/ directory exists", () => {
    assert.ok(existsSync(join(testDir, "memory/shared")));
  });

  test("git repo initialized", () => {
    assert.ok(existsSync(join(testDir, ".git")));
  });

  test(".gitignore contains tmp/", () => {
    const gitignore = readFileSync(join(testDir, ".gitignore"), "utf-8");
    assert.ok(gitignore.includes("tmp/"));
  });

  // Cleanup
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // Best effort
  }

  // Summary
  console.log(`\n━━━ Results: ${passed} passed, ${failed} failed ━━━\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("Test runner error:", err);
  // Cleanup on error too
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {}
  process.exit(1);
});
