// `script:` step — runs a skill script via the same allowlist + secret
// injection path as the run_script MCP tool. Captures stdout/exit code into
// $steps.<id>.stdout/json/error.

import { discoverProjectScripts, executeAllowedScript, resolveAllowedScript } from "../../mcp/script-exec.js";
import type { ScriptStep, Step, WorkflowInstance } from "../types.js";
import type { StepHandler, StepResult, StepRuntime } from "../runner.js";

export class ScriptStepHandler implements StepHandler {
  private readonly projectScriptsByRoot = new Map<string, Set<string>>();

  async run(step: Step, instance: WorkflowInstance, runtime: StepRuntime): Promise<StepResult> {
    if (step.type !== "script") return { status: "error", error: `wrong handler for ${step.type}` };
    const s = step as ScriptStep;
    const deps = runtime.deps;
    const scripts = this.getProjectScripts(deps.projectRoot);

    // Allow `${...}` interpolation in the script path and args.
    const scriptPath = runtime.interpolate(s.script);
    const stepArgs = (s.args ?? []).map((a) => runtime.interpolate(a));

    // First arg should be userName (matches run_script convention)
    const fullArgs = stepArgs.length > 0 && stepArgs[0] ? stepArgs : [instance.userName, ...stepArgs];

    const resolution = resolveAllowedScript({
      script: scriptPath,
      userName: instance.userName,
      agentId: instance.agentId,
      dataDir: deps.dataDir,
      projectScripts: scripts,
    });
    if (!resolution.ok) return { status: "error", error: resolution.error };

    const result = await executeAllowedScript({
      resolved: resolution.resolved,
      args: fullArgs,
      userName: instance.userName,
      vault: deps.vault,
      dataDir: deps.dataDir,
      projectRoot: deps.projectRoot,
      skill: resolution.skill,
      timeoutMs: s.timeoutMs,
      activityLabel: { ok: "Workflow step ran", error: "Workflow step failed" },
    });

    return buildScriptResult(result);
  }

  private getProjectScripts(projectRoot: string): Set<string> {
    let scripts = this.projectScriptsByRoot.get(projectRoot);
    if (!scripts) {
      scripts = discoverProjectScripts(projectRoot);
      this.projectScriptsByRoot.set(projectRoot, scripts);
    }
    return scripts;
  }
}

export function buildScriptResult(result: { stdout: string; stderr: string; exitCode: number }): StepResult {
  if (result.exitCode !== 0) {
    return { status: "error", stdout: result.stdout, error: result.stderr || `exit code ${result.exitCode}` };
  }
  let json: unknown;
  const trimmed = result.stdout.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { json = JSON.parse(trimmed); } catch {}
  }
  return { status: "ok", stdout: result.stdout, json };
}
