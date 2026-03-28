import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillCapabilityManifest } from "./mcp/script-security.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(message);
}

export function validateSkillManifest(manifestPath: string, scriptsDir: string): void {
  const raw = readFileSync(manifestPath, "utf-8");
  let parsed: SkillCapabilityManifest;

  try {
    parsed = JSON.parse(raw) as SkillCapabilityManifest;
  } catch (error) {
    fail(`Invalid JSON in ${manifestPath}: ${error instanceof Error ? error.message : error}`);
  }

  if (!isRecord(parsed)) {
    fail(`Invalid skill manifest ${manifestPath}: expected an object`);
  }

  if (parsed.scripts !== undefined && !isRecord(parsed.scripts)) {
    fail(`Invalid skill manifest ${manifestPath}: scripts must be an object`);
  }

  for (const [scriptName, config] of Object.entries(parsed.scripts ?? {})) {
    if (!scriptName.endsWith(".sh")) {
      fail(`Invalid skill manifest ${manifestPath}: script key ${scriptName} must be a shell script`);
    }

    if (!existsSync(join(scriptsDir, scriptName))) {
      fail(`Invalid skill manifest ${manifestPath}: script ${scriptName} does not exist`);
    }

    if (!isRecord(config)) {
      fail(`Invalid skill manifest ${manifestPath}: script ${scriptName} must be an object`);
    }

    if (config.redactOutput !== undefined && typeof config.redactOutput !== "boolean") {
      fail(`Invalid skill manifest ${manifestPath}: redactOutput for ${scriptName} must be boolean`);
    }

    if (config.secrets !== undefined) {
      if (!Array.isArray(config.secrets)) {
        fail(`Invalid skill manifest ${manifestPath}: secrets for ${scriptName} must be an array`);
      }

      for (const secret of config.secrets) {
        if (!isRecord(secret) || typeof secret.key !== "string" || !secret.key.trim()) {
          fail(`Invalid skill manifest ${manifestPath}: each secret for ${scriptName} must include a key`);
        }
        if (secret.fields !== undefined) {
          if (!Array.isArray(secret.fields) || secret.fields.some((field) => typeof field !== "string" || !field.trim())) {
            fail(`Invalid skill manifest ${manifestPath}: fields for ${scriptName} must be a string array`);
          }
        }
      }
    }
  }
}

export function validateSkillDirectories(skillsDir: string): void {
  if (!existsSync(skillsDir)) return;

  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(skillsDir, entry.name);
    const manifestPath = join(skillDir, "skill.json");
    if (!existsSync(manifestPath)) continue;
    validateSkillManifest(manifestPath, join(skillDir, "scripts"));
  }
}

export function validateProjectScriptsManifest(projectRoot: string): void {
  const scriptsDir = join(projectRoot, "scripts");
  const manifestPath = join(scriptsDir, "manifest.json");
  if (!existsSync(manifestPath)) return;
  validateSkillManifest(manifestPath, scriptsDir);
}
