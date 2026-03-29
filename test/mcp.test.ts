import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { strict as assert } from "node:assert";
import { buildScriptExecutionContext, redactSecrets } from "../src/mcp/script-security.js";
import { Vault, initializeVault } from "../src/vault/index.js";

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
  const testDir = join(tmpdir(), `steve-mcp-test-${Date.now()}`);
  const dataDir = join(testDir, "data");
  const projectRoot = join(testDir, "project");
  const vaultDir = join(testDir, "vault");

  mkdirSync(join(dataDir, "users", "robert", "skills", "weather", "scripts"), { recursive: true });
  mkdirSync(join(dataDir, "users", "robert", "skills", "legacy", "scripts"), { recursive: true });
  mkdirSync(join(projectRoot, "scripts"), { recursive: true });

  writeFileSync(join(dataDir, "users", "robert", "skills", "weather", "SKILL.md"), `---
name: Weather
description: Test skill
scripts:
  fetch.sh:
    redactOutput: false
    secrets:
      - key: users/{user}/weather/app
        fields: [api_key]
      - key: users/{user}/weather/tokens
        fields: [refresh_token]
---

# Weather
`, "utf-8");

  writeFileSync(join(projectRoot, "scripts", "manifest.json"), JSON.stringify({
    scripts: {
      "project-task.sh": {
        secrets: [
          { key: "{user}/global", fields: ["token"] },
        ],
      },
    },
  }, null, 2));

  const key = initializeVault(vaultDir, "test-password-123");
  const vault = new Vault(vaultDir, key);
  vault.set("users/robert/weather/app", { api_key: "weather-secret", ignored: "skip-me" } as any);
  vault.set("users/robert/weather/tokens", { refresh_token: "refresh-secret", access_token: "unused" } as any);
  vault.set("robert/legacy", { client_id: "legacy-id", client_secret: "legacy-secret" } as any);
  vault.set("robert/global", { token: "project-secret" } as any);
  vault.set("Robert/withings", { client_id: "mixed-client", client_secret: "mixed-secret" } as any);

  const manifestContext = buildScriptExecutionContext({
    vault,
    userName: "robert",
    scriptPath: join(dataDir, "users", "robert", "skills", "weather", "scripts", "fetch.sh"),
    dataDir,
    projectRoot,
    fallbackSkillName: "weather",
  });

  test("manifest: injects only declared secret fields", () => {
    assert.deepEqual(manifestContext.env, {
      STEVE_CRED_API_KEY: "weather-secret",
      STEVE_CRED_REFRESH_TOKEN: "refresh-secret",
    });
    assert.equal(manifestContext.usedManifest, true);
    assert.equal(manifestContext.redactOutput, false);
    assert.deepEqual(manifestContext.injectedSecretKeys, ["users/robert/weather/app", "users/robert/weather/tokens"]);
  });

  const fallbackContext = buildScriptExecutionContext({
    vault,
    userName: "robert",
    scriptPath: join(dataDir, "users", "robert", "skills", "legacy", "scripts", "setup.sh"),
    dataDir,
    projectRoot,
    fallbackSkillName: "legacy",
  });

  test("fallback: injects legacy prefix-based secrets when no manifest exists", () => {
    assert.equal(fallbackContext.usedManifest, false);
    assert.equal(fallbackContext.redactOutput, true);
    assert.deepEqual(fallbackContext.env, {
      STEVE_CRED_CLIENT_ID: "legacy-id",
      STEVE_CRED_CLIENT_SECRET: "legacy-secret",
    });
  });

  const projectContext = buildScriptExecutionContext({
    vault,
    userName: "robert",
    scriptPath: join(projectRoot, "scripts", "project-task.sh"),
    dataDir,
    projectRoot,
  });

  test("project scripts: support manifest-based secret injection", () => {
    assert.equal(projectContext.usedManifest, true);
    assert.deepEqual(projectContext.env, { STEVE_CRED_TOKEN: "project-secret" });
  });

  const mixedCaseContext = buildScriptExecutionContext({
    vault,
    userName: "robert",
    scriptPath: join(dataDir, "users", "robert", "skills", "weather", "scripts", "fetch.sh"),
    dataDir,
    projectRoot,
  });

  test("manifest: exact secret lookup is case-insensitive for migrated keys", () => {
    const withingsManifestPath = join(dataDir, "users", "robert", "skills", "withings", "SKILL.md");
    mkdirSync(join(dataDir, "users", "robert", "skills", "withings", "scripts"), { recursive: true });
    writeFileSync(withingsManifestPath, `---
name: Withings
description: Test skill
scripts:
  setup.sh:
    secrets:
      - key: users/{user}/withings/app
        fields: [client_id, client_secret]
---

# Withings
`, "utf-8");
    const ctx = buildScriptExecutionContext({
      vault,
      userName: "robert",
      scriptPath: join(dataDir, "users", "robert", "skills", "withings", "scripts", "setup.sh"),
      dataDir,
      projectRoot,
      fallbackSkillName: "withings",
    });
    assert.deepEqual(ctx.env, {
      STEVE_CRED_CLIENT_ID: "mixed-client",
      STEVE_CRED_CLIENT_SECRET: "mixed-secret",
    });
    assert.equal(ctx.redactOutput, true);
    assert.deepEqual(ctx.injectedSecretKeys, ["Robert/withings"]);
  });

  test("redaction: removes injected secret values from output", () => {
    const redacted = redactSecrets("token=weather-secret refresh=refresh-secret", manifestContext.injectedSecretValues);
    assert.equal(redacted.text, "token=[REDACTED] refresh=[REDACTED]");
    assert.equal(redacted.redactionCount, 2);
  });

  rmSync(testDir, { recursive: true, force: true });

  console.log(`\n━━━ MCP Script Security Results: ${passed} passed, ${failed} failed ━━━`);
  if (failed > 0) process.exit(1);
}

run();
