// `run:` step — arbitrary shell command via `bash -c`. Same threat model as
// the agent already has: the agent is trusted to write its own automation.
// No allowlist (use `script:` if you want allowlisted + secret-injected).

import { spawn } from "node:child_process";
import { appendUserActivity } from "../../activity.js";
import { config, getBaseUrl } from "../../config.js";
import type { RunStep, Step, WorkflowInstance } from "../types.js";
import type { StepHandler, StepResult, StepRuntime } from "../runner.js";
import { buildScriptResult } from "./script.js";

export class RunStepHandler implements StepHandler {
  async run(step: Step, instance: WorkflowInstance, runtime: StepRuntime): Promise<StepResult> {
    if (step.type !== "run") return { status: "error", error: `wrong handler for ${step.type}` };
    const s = step as RunStep;
    const deps = runtime.deps;

    const cmd = runtime.interpolate(s.run);
    const startedAt = Date.now();

    const result = await runShell(cmd, {
      timeoutMs: s.timeoutMs ?? 300_000,
      cwd: s.cwd,
      stdin: s.stdin,
      env: {
        KELLIX_PROJECT_ROOT: deps.projectRoot,
        KELLIX_DATA_DIR: deps.dataDir,
        KELLIX_BASE_URL: getBaseUrl(),
        ...(s.env ?? {}),
      },
    });

    appendUserActivity(config.dataDir, {
      timestamp: new Date().toISOString(),
      userName: instance.userName || "system",
      type: "script",
      status: result.exitCode === 0 ? "ok" : "error",
      summary: `Workflow run step: ${cmd.slice(0, 100)}${cmd.length > 100 ? "…" : ""} (${Date.now() - startedAt}ms)`,
    });

    return buildScriptResult(result);
  }
}

interface ShellOpts {
  timeoutMs: number;
  cwd?: string;
  stdin?: string;
  env?: Record<string, string>;
}

interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runShell(cmd: string, opts: ShellOpts): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", cmd], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      timeout: opts.timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    if (opts.stdin) child.stdin?.end(opts.stdin);
    child.on("close", (code, signal) => {
      const exitCode = code !== null ? code : signal ? 1 : 0;
      resolve({ stdout, stderr, exitCode });
    });
    child.on("error", (err) => {
      resolve({ stdout, stderr: stderr + (err.message ?? ""), exitCode: 1 });
    });
  });
}
