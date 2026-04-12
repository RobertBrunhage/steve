import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRunScriptAudit, getRunScriptAuditPath } from "../src/mcp/audit.js";
import { syncBundledSkillsForUser, validateProjectScriptsManifest, validateSkillDirectories, validateSkillManifest } from "../src/skills.js";
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
  const root = join(tmpdir(), `kellix-platform-test-${Date.now()}`);
  const skillsDir = join(root, "skills");
  const defaultSkillsDir = join(root, "defaults", "skills");
  const userSkillsDir = join(root, "users", "robert", "skills");
  const projectRoot = join(root, "project");
  const dataDir = join(root, "data");

  mkdirSync(join(skillsDir, "valid-skill", "scripts"), { recursive: true });
  mkdirSync(join(skillsDir, "invalid-skill", "scripts"), { recursive: true });
  mkdirSync(defaultSkillsDir, { recursive: true });
  mkdirSync(join(projectRoot, "scripts"), { recursive: true });

  writeFileSync(join(skillsDir, "valid-skill", "scripts", "fetch.sh"), "#!/usr/bin/env bash\n", "utf-8");
  writeFileSync(join(skillsDir, "valid-skill", "SKILL.md"), `---
name: Valid Skill
description: Test skill
scripts:
  fetch.sh:
    secrets:
      - key: "{user}/valid"
        fields: [token]
---

# Valid Skill
`, "utf-8");

  writeFileSync(join(skillsDir, "invalid-skill", "SKILL.md"), `---
name: Invalid Skill
description: Test skill
scripts:
  missing.sh:
    secrets:
      - key: ""
---

# Invalid Skill
`, "utf-8");

  writeFileSync(join(projectRoot, "scripts", "task.sh"), "#!/usr/bin/env bash\n", "utf-8");
  writeFileSync(join(projectRoot, "scripts", "manifest.json"), JSON.stringify({
    scripts: {
      "task.sh": {
        secrets: [{ key: "{user}/global", fields: ["token"] }],
      },
    },
  }, null, 2));

  mkdirSync(join(defaultSkillsDir, "weather", "scripts"), { recursive: true });
  writeFileSync(join(defaultSkillsDir, "weather", "SKILL.md"), "---\nname: Weather\ndescription: Test\n---\n\n# Weather\n", "utf-8");
  writeFileSync(join(defaultSkillsDir, "weather", "scripts", "fetch.sh"), "#!/usr/bin/env bash\n", "utf-8");
  writeFileSync(join(defaultSkillsDir, "TEMPLATE.md"), "# Template\n", "utf-8");

  test("audit: appends run_script metadata to jsonl log", () => {
    appendRunScriptAudit(dataDir, {
      timestamp: "2026-03-28T00:00:00.000Z",
      userName: "robert",
      script: "/data/skills/weather/scripts/fetch.sh",
      status: "ok",
      durationMs: 1200,
      secretKeys: ["users/robert/weather/app"],
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
    validateSkillManifest(join(skillsDir, "valid-skill", "SKILL.md"), join(skillsDir, "valid-skill", "scripts"));
  });

  test("skills: validates whole skills directory", () => {
    assert.throws(() => validateSkillDirectories(skillsDir), /missing\.sh/);
  });

  test("skills: validates project script manifest", () => {
    validateProjectScriptsManifest(projectRoot);
  });

  test("skills: copies bundled skills into a user workspace and skips existing entries by default", () => {
    const firstSync = syncBundledSkillsForUser(defaultSkillsDir, userSkillsDir);
    assert.deepEqual(firstSync.installed.sort(), ["TEMPLATE.md", "weather"]);
    assert.deepEqual(firstSync.updated, []);
    assert.deepEqual(firstSync.skipped, []);

    writeFileSync(join(userSkillsDir, "weather", "SKILL.md"), "# Custom Weather\n", "utf-8");
    const secondSync = syncBundledSkillsForUser(defaultSkillsDir, userSkillsDir);
    assert.deepEqual(secondSync.installed, []);
    assert.deepEqual(secondSync.updated, []);
    assert.deepEqual(secondSync.skipped.sort(), ["TEMPLATE.md", "weather"]);
    assert.equal(readFileSync(join(userSkillsDir, "weather", "SKILL.md"), "utf-8"), "# Custom Weather\n");
  });

  test("skills: force sync overwrites bundled skill entries", () => {
    const forced = syncBundledSkillsForUser(defaultSkillsDir, userSkillsDir, { force: true });
    assert.deepEqual(forced.installed, []);
    assert.deepEqual(forced.updated.sort(), ["TEMPLATE.md", "weather"]);
    assert.deepEqual(forced.skipped, []);
    assert.equal(readFileSync(join(userSkillsDir, "weather", "SKILL.md"), "utf-8"), "---\nname: Weather\ndescription: Test\n---\n\n# Weather\n");
  });

  test("users: invalid entries are ignored when normalizing", () => {
    const normalized = normalizeUsers({ robert: "12345", vanessa: { name: "vanessa", channels: { telegram: { chat_id: "67890" } } } });
    assert.deepEqual(normalized.users, {
      vanessa: {
        name: "vanessa",
        channels: {
          telegram: { chat_id: "67890" },
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
