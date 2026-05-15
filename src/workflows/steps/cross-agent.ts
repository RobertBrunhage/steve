// `cross_agent:` step — invoke a workflow on another agent (same user or
// optionally another user). Single-machine only in v1; LCP/1.0 wire protocol
// is unstable upstream so we deliberately don't lock it in here.

import type { CrossAgentStep, Step, WorkflowInstance } from "../types.js";
import type { StepHandler, StepResult, StepRuntime } from "../runner.js";

export class CrossAgentStepHandler implements StepHandler {
  async run(step: Step, instance: WorkflowInstance, runtime: StepRuntime): Promise<StepResult> {
    if (step.type !== "cross_agent") return { status: "error", error: `wrong handler for ${step.type}` };
    const s = step as CrossAgentStep;

    const targetUser = s.user ? runtime.interpolate(s.user) : instance.userName;
    const targetAgent = runtime.interpolate(s.agent);
    const targetWorkflow = runtime.interpolate(s.workflow);
    const args = s.args ? interpolateArgs(s.args, runtime) : {};
    const mode = s.mode ?? "sync";

    if (mode === "async") {
      // Fire and forget — return immediately with the spawned instance id.
      const promise = runtime.runner.runByName(targetUser, targetAgent, targetWorkflow, {
        args,
        triggerKind: "cross_agent",
        parentInstanceId: instance.id,
      });
      promise.catch(() => {});
      return { status: "ok", json: { mode: "async", started: true } };
    }

    try {
      const child = await runtime.runner.runByName(targetUser, targetAgent, targetWorkflow, {
        args,
        triggerKind: "cross_agent",
        parentInstanceId: instance.id,
      });
      if (child.status === "error") {
        return { status: "error", error: child.error?.message ?? "cross_agent workflow failed" };
      }
      return { status: "ok", json: child.output, stdout: typeof child.output === "string" ? child.output : undefined };
    } catch (err) {
      return { status: "error", error: err instanceof Error ? err.message : String(err) };
    }
  }
}

function interpolateArgs(args: Record<string, unknown>, runtime: StepRuntime): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === "string" ? runtime.interpolate(v) : v;
  }
  return out;
}
