import { existsSync, readFileSync } from "node:fs";
import matter from "gray-matter";

export interface ScriptSecretSpec {
  key: string;
  fields?: string[];
}

export interface ScriptCapabilityManifest {
  secrets?: ScriptSecretSpec[];
  redactOutput?: boolean;
}

export interface SkillCapabilityManifest {
  scripts?: Record<string, ScriptCapabilityManifest>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(message);
}

export function parseSkillCapabilityManifest(data: unknown, sourceName: string): SkillCapabilityManifest {
  if (!isRecord(data)) {
    fail(`Invalid skill manifest ${sourceName}: expected an object`);
  }

  if (data.scripts !== undefined && !isRecord(data.scripts)) {
    fail(`Invalid skill manifest ${sourceName}: scripts must be an object`);
  }

  const parsed = data as SkillCapabilityManifest;

  for (const [scriptName, config] of Object.entries(parsed.scripts ?? {})) {
    if (!scriptName.endsWith(".sh")) {
      fail(`Invalid skill manifest ${sourceName}: script key ${scriptName} must be a shell script`);
    }

    if (!isRecord(config)) {
      fail(`Invalid skill manifest ${sourceName}: script ${scriptName} must be an object`);
    }

    if (config.redactOutput !== undefined && typeof config.redactOutput !== "boolean") {
      fail(`Invalid skill manifest ${sourceName}: redactOutput for ${scriptName} must be boolean`);
    }

    if (config.secrets !== undefined) {
      if (!Array.isArray(config.secrets)) {
        fail(`Invalid skill manifest ${sourceName}: secrets for ${scriptName} must be an array`);
      }

      for (const secret of config.secrets) {
        if (!isRecord(secret) || typeof secret.key !== "string" || !secret.key.trim()) {
          fail(`Invalid skill manifest ${sourceName}: each secret for ${scriptName} must include a key`);
        }
        if (secret.fields !== undefined) {
          if (!Array.isArray(secret.fields) || secret.fields.some((field) => typeof field !== "string" || !field.trim())) {
            fail(`Invalid skill manifest ${sourceName}: fields for ${scriptName} must be a string array`);
          }
        }
      }
    }
  }

  return parsed;
}

export function loadSkillManifestFromMarkdown(skillPath: string): SkillCapabilityManifest | null {
  if (!existsSync(skillPath)) return null;
  const raw = readFileSync(skillPath, "utf-8");
  const parsed = matter(raw);
  if (!isRecord(parsed.data)) return null;

  // Spec-compliant location: metadata.kellix.scripts
  const metadata = isRecord(parsed.data.metadata) ? parsed.data.metadata : null;
  const kellixMeta = metadata && isRecord(metadata.kellix) ? metadata.kellix : null;
  const scripts = kellixMeta && kellixMeta.scripts !== undefined ? kellixMeta.scripts : undefined;

  if (scripts === undefined) return null;
  return parseSkillCapabilityManifest({ scripts }, skillPath);
}

export function loadJsonSkillManifest(manifestPath: string): SkillCapabilityManifest | null {
  if (!existsSync(manifestPath)) return null;

  const raw = readFileSync(manifestPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`Invalid JSON in ${manifestPath}: ${error instanceof Error ? error.message : error}`);
  }

  return parseSkillCapabilityManifest(parsed, manifestPath);
}
