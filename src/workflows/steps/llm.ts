// `llm:` step — calls the calling agent's existing OpenCode container via
// brain.promptOnce. Returns the assistant's text as $stepId.stdout, optionally
// extracts a fenced JSON block as $stepId.json when `return: json`.

import type { LlmStep, Step, WorkflowInstance } from "../types.js";
import type { StepHandler, StepResult, StepRuntime } from "../runner.js";

export class LlmStepHandler implements StepHandler {
  async run(step: Step, instance: WorkflowInstance, runtime: StepRuntime): Promise<StepResult> {
    if (step.type !== "llm") return { status: "error", error: `wrong handler for ${step.type}` };
    const s = step as LlmStep;
    const prompt = runtime.interpolate(s.prompt);
    try {
      const text = await runtime.deps.brain.promptOnce(instance.userName, instance.agentId, prompt);
      let json: unknown;
      if (s.return === "json") {
        json = extractFencedJson(text);
      } else {
        const trimmed = text.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          try { json = JSON.parse(trimmed); } catch {}
        }
      }
      return { status: "ok", stdout: text, json };
    } catch (err) {
      return { status: "error", error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * Pull the first fenced ```json ... ``` block out of an assistant message.
 * Falls back to attempting to parse the entire string if no fence is present.
 */
export function extractFencedJson(text: string): unknown {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]); } catch {}
  }
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { return JSON.parse(trimmed); } catch {}
  }
  return undefined;
}
