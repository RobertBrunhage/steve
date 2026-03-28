import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRunScriptAudit, getRunScriptAuditPath } from "../src/mcp/audit.js";
import { validateProjectScriptsManifest, validateSkillDirectories, validateSkillManifest } from "../src/skills.js";
import { normalizeUsers } from "../src/users.js";

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

function run() {
  const root = join(tmpdir(), `steve-platform-test-${Date.now()}`);
  const skillsDir = join(root, "skills");
  const projectRoot = join(root, "project");
  const dataDir = join(root, "data");

  mkdirSync(join(skillsDir, "valid-skill", "scripts"), { recursive: true });
  mkdirSync(join(skillsDir, "invalid-skill", "scripts"), { recursive: true });
  mkdirSync(join(projectRoot, "scripts"), { recursive: true });

  writeFileSync(join(skillsDir, "valid-skill", "scripts", "fetch.sh"), "#!/usr/bin/env bash\n", "utf-8");
  writeFileSync(join(skillsDir, "valid-skill", "skill.json"), JSON.stringify({
    scripts: {
      "fetch.sh": {
        secrets: [{ key: "{user}/valid", fields: ["token"] }],
      },
    },
  }, null, 2));

  writeFileSync(join(skillsDir, "invalid-skill", "skill.json"), JSON.stringify({
    scripts: {
      "missing.sh": {
        secrets: [{ key: "" }],
      },
    },
  }, null, 2));

  writeFileSync(join(projectRoot, "scripts", "task.sh"), "#!/usr/bin/env bash\n", "utf-8");
  writeFileSync(join(projectRoot, "scripts", "manifest.json"), JSON.stringify({
    scripts: {
      "task.sh": {
        secrets: [{ key: "{user}/global", fields: ["token"] }],
      },
    },
  }, null, 2));

  test("audit: appends run_script metadata to jsonl log", () => {
    appendRunScriptAudit(dataDir, {
      timestamp: "2026-03-28T00:00:00.000Z",
      userName: "robert",
      script: "/data/skills/weather/scripts/fetch.sh",
      status: "ok",
      durationMs: 1200,
      secretKeys: ["robert/weather"],
      usedManifest: true,
      redactionCount: 2,
    });

    const filePath = getRunScriptAuditPath(dataDir);
    const lines = readFileSync(filePath, "utf-8").trim().split("\n");
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.userName, "robert");
    assert.equal(entry.redactionCount, 2);
  });

  test("skills: accepts valid skill manifest", () => {
    validateSkillManifest(join(skillsDir, "valid-skill", "skill.json"), join(skillsDir, "valid-skill", "scripts"));
  });

  test("skills: validates whole skills directory", () => {
    assert.throws(() => validateSkillDirectories(skillsDir), /missing\.sh/);
  });

  test("skills: validates project script manifest", () => {
    validateProjectScriptsManifest(projectRoot);
  });

  test("users: legacy telegram-id map migrates to user-centric shape", () => {
    const normalized = normalizeUsers({ "12345": "robert" });
    assert.equal(normalized.migrated, true);
    assert.deepEqual(normalized.users, {
      robert: {
        name: "robert",
        channels: {
          telegram: { chat_id: "12345" },
        },
      },
    });
  });

  test("users: names resolve case-insensitively", () => {
    const users = normalizeUsers({ robert: { name: "robert", channels: { telegram: { chat_id: "12345" } } } }).users;
    assert.equal(users.robert.name, "robert");
  });

  rmSync(root, { recursive: true, force: true });

  console.log(`\n━━━ Platform Results: ${passed} passed, ${failed} failed ━━━`);
  if (failed > 0) process.exit(1);
}

run();
