import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadJsonSkillManifest, loadSkillManifestFromMarkdown } from "./skill-manifest.js";

export interface SyncBundledSkillsOptions {
  force?: boolean;
}

export interface SyncBundledSkillsResult {
  installed: string[];
  updated: string[];
  skipped: string[];
}

function fail(message: string): never {
  throw new Error(message);
}

export function validateSkillManifest(manifestPath: string, scriptsDir: string): void {
  const parsed = manifestPath.endsWith(".md")
    ? loadSkillManifestFromMarkdown(manifestPath)
    : loadJsonSkillManifest(manifestPath);
  if (!parsed) return;

  for (const [scriptName, config] of Object.entries(parsed.scripts ?? {})) {
    if (!scriptName.endsWith(".sh")) {
      fail(`Invalid skill manifest ${manifestPath}: script key ${scriptName} must be a shell script`);
    }

    if (!existsSync(join(scriptsDir, scriptName))) {
      fail(`Invalid skill manifest ${manifestPath}: script ${scriptName} does not exist`);
    }

  }
}

export function validateSkillDirectories(skillsDir: string): void {
  if (!existsSync(skillsDir)) return;

  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillDir = join(skillsDir, entry.name);
    const manifestPath = join(skillDir, "SKILL.md");
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

export function syncBundledWorkflowDocs(defaultWorkflowsDir: string, agentWorkflowsDir: string): void {
  // Copy WORKFLOW_TEMPLATE.md + SCHEMA.json into the agent's workflows/ so the
  // agent has the spec alongside its own .workflow.yaml files. Examples are
  // intentionally NOT copied — they have cron triggers that would activate
  // automatically. Agents copy + adapt from defaults/workflows/examples/.
  if (!existsSync(defaultWorkflowsDir)) return;
  mkdirSync(agentWorkflowsDir, { recursive: true });
  for (const file of ["WORKFLOW_TEMPLATE.md", "SCHEMA.json"]) {
    const src = join(defaultWorkflowsDir, file);
    const dest = join(agentWorkflowsDir, file);
    if (existsSync(src) && !existsSync(dest)) cpSync(src, dest);
  }
}

export function syncBundledSkillsForUser(
  defaultSkillsDir: string,
  userSkillsDir: string,
  options: SyncBundledSkillsOptions = {},
): SyncBundledSkillsResult {
  const result: SyncBundledSkillsResult = {
    installed: [],
    updated: [],
    skipped: [],
  };

  if (!existsSync(defaultSkillsDir)) {
    return result;
  }

  const force = options.force ?? false;
  mkdirSync(userSkillsDir, { recursive: true });

  for (const entry of readdirSync(defaultSkillsDir)) {
    const sourcePath = join(defaultSkillsDir, entry);
    const targetPath = join(userSkillsDir, entry);
    const alreadyExists = existsSync(targetPath);

    if (alreadyExists && !force) {
      result.skipped.push(entry);
      continue;
    }

    if (alreadyExists) {
      rmSync(targetPath, { recursive: true, force: true });
      result.updated.push(entry);
    } else {
      result.installed.push(entry);
    }

    cpSync(sourcePath, targetPath, { recursive: true });
  }

  return result;
}
