// `workflow:` step — invoke another workflow definition (same agent) as a
// subroutine. Optional `loop:` block iterates the sub-workflow up to N times
// while a condition holds, exposing KELLIX_LOOP_* env vars in each iteration.

import type { Step, SubWorkflowStep, WorkflowInstance } from "../types.js";
import type { StepHandler, StepResult, StepRuntime } from "../runner.js";
import { evaluate } from "../expressions.js";

export class SubWorkflowStepHandler implements StepHandler {
  async run(step: Step, instance: WorkflowInstance, runtime: StepRuntime): Promise<StepResult> {
    if (step.type !== "workflow") return { status: "error", error: `wrong handler for ${step.type}` };
    const s = step as SubWorkflowStep;

    const args = s.args ? interpolateArgs(s.args, runtime) : {};
    const maxIter = s.loop?.maxIterations ?? 1;
    const loopCondition = s.loop?.condition;

    let last: WorkflowInstance | null = null;
    let iteration = 0;
    while (iteration < maxIter) {
      iteration++;
      try {
        const child = await runtime.runner.runByName(instance.userName, instance.agentId, s.workflow, {
          args: { ...args, KELLIX_LOOP_ITERATION: iteration },
          triggerKind: "sub",
          parentInstanceId: instance.id,
        });
        last = child;
        if (child.status === "error") {
          return { status: "error", error: child.error?.message ?? "sub-workflow failed", json: child.output };
        }
        if (!loopCondition) break;
        // Evaluate loop condition in a context that exposes the previous
        // iteration's output as $loop.json + $loop.stdout.
        const loopCtx = { steps: instance.steps, args: instance.args, loop: { iteration, stdout: child.output && typeof child.output === "string" ? child.output : undefined, json: child.output } };
        try {
          if (!evaluate(loopCondition, loopCtx as unknown as Parameters<typeof evaluate>[1])) break;
        } catch { break; }
      } catch (err) {
        return { status: "error", error: err instanceof Error ? err.message : String(err) };
      }
    }
    return { status: "ok", json: last?.output, stdout: last?.output && typeof last.output === "string" ? last.output : undefined };
  }
}

function interpolateArgs(args: Record<string, unknown>, runtime: StepRuntime): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === "string" ? runtime.interpolate(v) : v;
  }
  return out;
}
