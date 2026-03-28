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

  mkdirSync(join(dataDir, "skills", "weather", "scripts"), { recursive: true });
  mkdirSync(join(dataDir, "skills", "legacy", "scripts"), { recursive: true });
  mkdirSync(join(projectRoot, "scripts"), { recursive: true });

  writeFileSync(join(dataDir, "skills", "weather", "skill.json"), JSON.stringify({
    scripts: {
      "fetch.sh": {
        secrets: [
          { key: "{user}/weather", fields: ["api_key"] },
          { key: "{user}/weather-tokens", fields: ["refresh_token"] },
        ],
      },
    },
  }, null, 2));

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
  vault.set("robert/weather", { api_key: "weather-secret", ignored: "skip-me" } as any);
  vault.set("robert/weather-tokens", { refresh_token: "refresh-secret", access_token: "unused" } as any);
  vault.set("robert/legacy", { client_id: "legacy-id", client_secret: "legacy-secret" } as any);
  vault.set("robert/global", { token: "project-secret" } as any);

  const manifestContext = buildScriptExecutionContext({
    vault,
    userName: "robert",
    scriptPath: join(dataDir, "skills", "weather", "scripts", "fetch.sh"),
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
    assert.deepEqual(manifestContext.injectedSecretKeys, ["robert/weather", "robert/weather-tokens"]);
  });

  const fallbackContext = buildScriptExecutionContext({
    vault,
    userName: "robert",
    scriptPath: join(dataDir, "skills", "legacy", "scripts", "setup.sh"),
    dataDir,
    projectRoot,
    fallbackSkillName: "legacy",
  });

  test("fallback: injects legacy prefix-based secrets when no manifest exists", () => {
    assert.equal(fallbackContext.usedManifest, false);
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
