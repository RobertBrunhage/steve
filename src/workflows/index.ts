// Barrel + factory for the workflow engine.

import type { Brain } from "../brain/index.js";
import type { Channel } from "../channels/index.js";
import type { Vault } from "../vault/index.js";
import { WorkflowRunner } from "./runner.js";
import { ApprovalStepHandler } from "./steps/approval.js";
import { LlmStepHandler } from "./steps/llm.js";
import { PipelineStepHandler } from "./steps/pipeline.js";
import { RunStepHandler } from "./steps/run.js";
import { ScriptStepHandler } from "./steps/script.js";

export { WorkflowRunner } from "./runner.js";
export { parseWorkflow, workflowVersion } from "./parser.js";
export { evaluate, interpolate, coerceBool, EvalError } from "./expressions.js";
export {
  deleteWorkflow,
  findWaitingByAgent,
  getUserAgentWorkflowsDir,
  listInstances,
  listWorkflows,
  listWorkflowFiles,
  readInstance,
  readWorkflow,
  readWorkflowRaw,
  scanRunnableInstances,
  writeInstance,
  writeWorkflow,
} from "./storage.js";
export { appendWorkflowAudit } from "./audit.js";
export * from "./types.js";

export interface WorkflowEngineDeps {
  brain: Brain;
  channel: Channel;
  vault: Vault | null;
  dataDir: string;
  projectRoot: string;
}

/**
 * Build the workflow engine with all step handlers registered. Phase 1 starts
 * with no handlers (validate + list MCP works on definitions only). Subsequent
 * phases register run/llm/approval/etc.
 */
export function createWorkflowEngine(deps: WorkflowEngineDeps): WorkflowRunner {
  const runner = new WorkflowRunner(deps);
  runner.registerStepHandler("run", new RunStepHandler());
  runner.registerStepHandler("script", new ScriptStepHandler());
  runner.registerStepHandler("llm", new LlmStepHandler());
  runner.registerStepHandler("pipeline", new PipelineStepHandler());
  runner.registerStepHandler("approval", new ApprovalStepHandler());
  // workflow / cross_agent / wait registered in later phases.
  return runner;
}
