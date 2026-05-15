// `wait:` step — sleeps for `for_ms` or polls until an expression becomes
// truthy. Useful for retrying conditions without a full retry loop, or
// pacing follow-up steps after an async cross-agent kickoff.

import { coerceBool } from "../expressions.js";
import type { Step, WaitStep, WorkflowInstance } from "../types.js";
import type { StepHandler, StepResult, StepRuntime } from "../runner.js";

export class WaitStepHandler implements StepHandler {
  async run(step: Step, _instance: WorkflowInstance, runtime: StepRuntime): Promise<StepResult> {
    if (step.type !== "wait") return { status: "error", error: `wrong handler for ${step.type}` };
    const s = step as WaitStep;

    if (s.forMs !== undefined) {
      await sleep(s.forMs);
      return { status: "ok" };
    }

    if (s.until) {
      const deadline = s.timeoutMs ? Date.now() + s.timeoutMs : undefined;
      const pollMs = s.pollMs ?? 1000;
      while (true) {
        try {
          if (coerceBool(runtime.evaluate(s.until))) return { status: "ok" };
        } catch {
          return { status: "error", error: `wait until expression failed: ${s.until}` };
        }
        if (deadline && Date.now() >= deadline) {
          return { status: "error", error: "wait_timeout" };
        }
        await sleep(pollMs);
      }
    }

    return { status: "error", error: "wait step requires for_ms or until" };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
