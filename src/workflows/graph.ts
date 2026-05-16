// Mermaid + Graphviz DOT rendering for a workflow definition. Sequential by
// default; conditional steps render a dashed edge from the prior step to
// indicate the when/condition. Sub-workflow + cross-agent steps render with
// their callee names labeled.

import type { Step, WorkflowDef } from "./types.js";

function nodeLabel(step: Step): string {
  const head = step.name ? `${step.id}: ${step.name}` : step.id;
  if (step.type === "run") return `${head}\\n[run]`;
  if (step.type === "script") return `${head}\\n[script]`;
  if (step.type === "llm") return `${head}\\n[llm]`;
  if (step.type === "pipeline") return `${head}\\n[pipeline ${step.pipeline.split(/\s+/)[0]}]`;
  if (step.type === "approval") return `${head}\\n[approval]`;
  if (step.type === "workflow") return `${head}\\n[workflow:${step.workflow}]`;
  if (step.type === "cross_agent") return `${head}\\n[cross:${step.agent}/${step.workflow}]`;
  if (step.type === "wait") return `${head}\\n[wait]`;
  return head;
}

export function renderMermaid(def: WorkflowDef): string {
  const lines = ["graph TD"];
  for (const step of def.steps) {
    const label = nodeLabel(step).replace(/"/g, "'");
    lines.push(`  ${step.id}["${label}"]`);
  }
  for (let i = 1; i < def.steps.length; i++) {
    const prev = def.steps[i - 1];
    const curr = def.steps[i];
    const conditional = !!(curr.when || curr.condition);
    lines.push(`  ${prev.id} ${conditional ? "-.->" : "-->"} ${curr.id}`);
  }
  return lines.join("\n");
}

export function renderDot(def: WorkflowDef): string {
  const lines = ["digraph workflow {", "  rankdir=TB;", "  node [shape=box, fontsize=10];"];
  for (const step of def.steps) {
    const label = nodeLabel(step).replace(/"/g, "'").replace(/\\n/g, "\\n");
    lines.push(`  "${step.id}" [label="${label}"];`);
  }
  for (let i = 1; i < def.steps.length; i++) {
    const prev = def.steps[i - 1];
    const curr = def.steps[i];
    const style = curr.when || curr.condition ? ' [style=dashed]' : "";
    lines.push(`  "${prev.id}" -> "${curr.id}"${style};`);
  }
  lines.push("}");
  return lines.join("\n");
}
