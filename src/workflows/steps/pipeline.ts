// `pipeline:` step — pure data transforms over the prior step's JSON output.
// Lobster-compatible: `where <expr>` / `pick <fields>` / `json` / `table`.
//
// Input defaults to the most-recent step's `json` (falling back to `stdout`
// parsed as JSON). Caller can override with `input: $steps.<id>.json` style.

import { evaluate } from "../expressions.js";
import type { PipelineStep, Step, WorkflowInstance } from "../types.js";
import type { StepHandler, StepResult, StepRuntime } from "../runner.js";

export class PipelineStepHandler implements StepHandler {
  async run(step: Step, instance: WorkflowInstance, runtime: StepRuntime): Promise<StepResult> {
    if (step.type !== "pipeline") return { status: "error", error: `wrong handler for ${step.type}` };
    const s = step as PipelineStep;

    const input = s.input ? runtime.evaluate(s.input) : findPriorStepJson(instance);

    const expr = s.pipeline.trim();
    const [verb, ...rest] = expr.split(/\s+/);
    let arg = expr.slice(verb.length).trim();
    // Lobster's canonical form quotes the expression: `where "$_.sev == 'high'"`.
    // Strip a single layer of wrapping double-or-single quotes so the inner
    // expression goes to the evaluator directly.
    if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
      arg = arg.slice(1, -1);
    }

    try {
      if (verb === "json") {
        return { status: "ok", json: input };
      }
      if (verb === "table") {
        const rows = Array.isArray(input) ? input : [];
        const stdout = rows.map((row) => JSON.stringify(row)).join("\n");
        return { status: "ok", stdout, json: rows };
      }
      if (verb === "where") {
        // Inside a `where` expression, `$_` refers to the current array item
        // (Lobster convention). Steps + args remain available too.
        const filtered = (Array.isArray(input) ? input : []).filter((item) => {
          try {
            const ctx = { steps: instance.steps, args: instance.args, _: item } as unknown as Parameters<typeof evaluate>[1];
            return Boolean(evaluate(arg, ctx));
          } catch {
            return false;
          }
        });
        return { status: "ok", json: filtered };
      }
      if (verb === "pick") {
        const fields = arg.split(/[,\s]+/).map((f) => f.trim()).filter(Boolean);
        const project = (item: unknown): Record<string, unknown> => {
          if (!item || typeof item !== "object") return {};
          const obj = item as Record<string, unknown>;
          const out: Record<string, unknown> = {};
          for (const f of fields) {
            if (Object.prototype.hasOwnProperty.call(obj, f)) out[f] = obj[f];
          }
          return out;
        };
        const result = Array.isArray(input) ? input.map(project) : project(input);
        return { status: "ok", json: result };
      }
      return { status: "error", error: `unknown pipeline verb '${verb}'` };
    } catch (err) {
      return { status: "error", error: err instanceof Error ? err.message : String(err) };
    }
  }
}

function findPriorStepJson(instance: WorkflowInstance): unknown {
  const stepIds = Object.keys(instance.steps);
  for (let i = stepIds.length - 1; i >= 0; i--) {
    const state = instance.steps[stepIds[i]];
    if (state.json !== undefined) return state.json;
    if (state.stdout) {
      const trimmed = state.stdout.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try { return JSON.parse(trimmed); } catch {}
      }
    }
  }
  return undefined;
}
