// Barrel + factory for the workflow engine.

import type { Brain } from "../brain/index.js";
import type { Channel } from "../channels/index.js";
import type { Vault } from "../vault/index.js";
import { WorkflowRunner } from "./runner.js";

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
  // Step handlers are registered as they're implemented in later phases.
  return runner;
}
