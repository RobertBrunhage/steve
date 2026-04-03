import { basename, join, relative, resolve } from "node:path";
import type { Vault } from "../vault/index.js";
import { loadJsonSkillManifest, loadSkillManifestFromMarkdown, type SkillCapabilityManifest } from "../skill-manifest.js";

export interface ScriptExecutionContext {
  env: Record<string, string>;
  injectedSecretValues: string[];
  injectedSecretKeys: string[];
  usedManifest: boolean;
  redactOutput: boolean;
}

function toEnvKey(field: string): string {
  return `STEVE_CRED_${field.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

function resolveTemplate(value: string, userName: string): string {
  return value.replaceAll("{user}", userName).replaceAll("{userName}", userName);
}

function getSkillRoot(scriptPath: string, dataDir: string): string | null {
  const resolved = resolve(scriptPath);
  const sharedSkillsDir = resolve(join(dataDir, "skills"));
  if (resolved.startsWith(sharedSkillsDir + "/")) {
    const relativePath = relative(sharedSkillsDir, resolved);
    const [skillName] = relativePath.split("/");
    return skillName ? join(sharedSkillsDir, skillName) : null;
  }

  const usersDir = resolve(join(dataDir, "users"));
  if (resolved.startsWith(usersDir + "/")) {
    const relativePath = relative(usersDir, resolved);
    const parts = relativePath.split("/");
    if (parts.length >= 4 && parts[1] === "skills") {
      return join(usersDir, parts[0], parts[1], parts[2]);
    }
  }

  return null;
}

function getProjectScriptsRoot(scriptPath: string, projectRoot: string): string | null {
  const scriptsDir = resolve(join(projectRoot, "scripts"));
  const resolved = resolve(scriptPath);
  if (resolved.startsWith(scriptsDir + "/")) {
    return scriptsDir;
  }
  return null;
}

export function loadScriptManifest(scriptPath: string, dataDir: string, projectRoot: string): { manifest: SkillCapabilityManifest | null; scriptName: string } {
  const skillRoot = getSkillRoot(scriptPath, dataDir);
  if (skillRoot) {
    return {
      manifest: loadSkillManifestFromMarkdown(join(skillRoot, "SKILL.md")),
      scriptName: basename(scriptPath),
    };
  }

  const projectScriptsRoot = getProjectScriptsRoot(scriptPath, projectRoot);
  if (projectScriptsRoot) {
    return {
      manifest: loadJsonSkillManifest(join(projectScriptsRoot, "manifest.json")),
      scriptName: basename(scriptPath),
    };
  }

  return { manifest: null, scriptName: basename(scriptPath) };
}

function injectSecretFields(env: Record<string, string>, injectedSecretValues: string[], record: Record<string, unknown>, fields?: string[]) {
  const selectedFields = fields && fields.length > 0 ? fields : Object.keys(record);

  for (const field of selectedFields) {
    if (!(field in record)) continue;
    const envValue = String(record[field]);
    env[toEnvKey(field)] = envValue;
    injectedSecretValues.push(envValue);
  }
}

function getVaultObject(vault: Vault, key: string): { resolvedKey: string; value: Record<string, unknown> } | null {
  const exact = vault.get(key);
  if (exact && typeof exact === "object") {
    return { resolvedKey: key, value: exact };
  }
  return null;
}

export function buildScriptExecutionContext(options: {
  vault: Vault | null;
  userName: string;
  scriptPath: string;
  dataDir: string;
  projectRoot: string;
}): ScriptExecutionContext {
  const { vault, userName, scriptPath, dataDir, projectRoot } = options;

  if (!vault || !userName) {
    return { env: {}, injectedSecretValues: [], injectedSecretKeys: [], usedManifest: false, redactOutput: true };
  }

  const { manifest, scriptName } = loadScriptManifest(scriptPath, dataDir, projectRoot);
  const scriptManifest = manifest?.scripts?.[scriptName];
  const env: Record<string, string> = {};
  const injectedSecretValues: string[] = [];
  const injectedSecretKeys: string[] = [];

  if (scriptManifest?.secrets) {
    for (const secret of scriptManifest.secrets) {
      const key = resolveTemplate(secret.key, userName);
      const match = getVaultObject(vault, key);
      if (!match) continue;
      injectedSecretKeys.push(match.resolvedKey);
      injectSecretFields(env, injectedSecretValues, match.value, secret.fields);
    }

      return {
        env,
        injectedSecretValues,
        injectedSecretKeys,
        usedManifest: true,
        redactOutput: scriptManifest.redactOutput !== false,
      };
    }

  return {
    env,
    injectedSecretValues,
    injectedSecretKeys,
    usedManifest: false,
    redactOutput: true,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactSecrets(text: string, secrets: string[]): { text: string; redactionCount: number } {
  let nextText = text;
  let redactionCount = 0;
  const values = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);

  for (const secret of values) {
    const matches = nextText.match(new RegExp(escapeRegExp(secret), "g"));
    if (!matches) continue;
    redactionCount += matches.length;
    nextText = nextText.replace(new RegExp(escapeRegExp(secret), "g"), "[REDACTED]");
  }

  return { text: nextText, redactionCount };
}
