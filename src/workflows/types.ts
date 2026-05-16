// Workflow engine types. Public surface is everything that can appear in a
// .workflow.yaml file plus the runtime state that backs each execution.
//
// The YAML schema mirrors OpenClaw's Lobster syntax (run / pipeline / approval /
// workflow:/lobster: / when) with Kellix-specific additions (clean `llm:`,
// `script:`, `cross_agent:`, `wait:`). Lobster's `pipeline: llm.invoke ...`
// form is accepted as an alias mapping to llm:.

export type RunStatus =
  | "running"
  | "waiting_approval"
  | "ok"
  | "error"
  | "cancelled";

export type StepStatus =
  | "pending"
  | "running"
  | "ok"
  | "error"
  | "skipped"
  | "waiting";

export type OnError = "stop" | "continue" | "skip_rest";

export type ConcurrencyMode = "queue" | "skip" | "parallel";

export interface RetryPolicy {
  max: number;
  backoff?: "exponential" | "linear" | "none";
  delayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
}

export interface Trigger {
  cron?: string;
  at?: string;
  every?: string;
  manual?: boolean;
  webhook?: string;
  event?: string;
  timezone?: string;
}

export interface ArgDef {
  description?: string;
  default?: unknown;
  required?: boolean;
}

export interface ApprovalDefaults {
  requiredApprover?: string;
  requireDifferentApprover?: boolean;
  timeoutMs?: number;
}

export interface StepBase {
  id: string;
  name?: string;
  when?: string;
  condition?: string;
  onError?: OnError;
  retry?: RetryPolicy;
  env?: Record<string, string>;
}

export interface RunStep extends StepBase {
  type: "run";
  run: string;
  timeoutMs?: number;
  cwd?: string;
  stdin?: string;
}

export interface ScriptStep extends StepBase {
  type: "script";
  script: string;
  args?: string[];
  timeoutMs?: number;
}

export interface LlmStep extends StepBase {
  type: "llm";
  prompt: string;
  isolated?: boolean;
  return?: "stdout" | "json";
}

export interface PipelineStep extends StepBase {
  type: "pipeline";
  pipeline: string;
  input?: string;
}

export interface ApprovalStep extends StepBase {
  type: "approval";
  reason: string;
  requiredApprover?: string;
  requireDifferentApprover?: boolean;
  timeoutMs?: number;
  buttons?: string[][];
}

export interface SubWorkflowStep extends StepBase {
  type: "workflow";
  workflow: string;
  args?: Record<string, unknown>;
  loop?: {
    maxIterations: number;
    condition?: string;
  };
}

export interface CrossAgentStep extends StepBase {
  type: "cross_agent";
  agent: string;
  workflow: string;
  user?: string;
  args?: Record<string, unknown>;
  mode?: "sync" | "async";
  timeoutMs?: number;
}

export interface WaitStep extends StepBase {
  type: "wait";
  forMs?: number;
  until?: string;
  pollMs?: number;
  timeoutMs?: number;
}

export type Step =
  | RunStep
  | ScriptStep
  | LlmStep
  | PipelineStep
  | ApprovalStep
  | SubWorkflowStep
  | CrossAgentStep
  | WaitStep;

export interface WorkflowDef {
  name: string;
  description?: string;
  args?: Record<string, ArgDef>;
  triggers?: Trigger[];
  env?: Record<string, string>;
  condition?: string;
  concurrency?: { mode: ConcurrencyMode; limit?: number };
  steps: Step[];
  approvalDefaults?: ApprovalDefaults;
  sourcePath?: string;
  sourceYaml?: string;
}

export interface StepState {
  id: string;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  attempt: number;
  stdout?: string;
  json?: unknown;
  error?: string;
  approved?: boolean;
  approvedBy?: string;
  response?: string;
  iteration?: number;
}

export interface WaitingApprovalState {
  stepId: string;
  kind: "approval";
  prompt: string;
  requiredApprover?: string;
  requireDifferentApprover?: boolean;
  deadline?: string;
  buttons?: string[][];
  requestedBy?: string;
  requestedAt: string;
}

export interface WorkflowInstance {
  id: string;
  userName: string;
  agentId: string;
  workflowName: string;
  workflowVersion: string;
  status: RunStatus;
  trigger: {
    kind: "cron" | "manual" | "webhook" | "event" | "at" | "sub" | "cross_agent";
    meta?: Record<string, unknown>;
  };
  args: Record<string, unknown>;
  steps: Record<string, StepState>;
  currentStepId?: string;
  waiting?: WaitingApprovalState;
  startedAt: string;
  finishedAt?: string;
  error?: {
    stepId?: string;
    message: string;
    code?: string;
  };
  output?: unknown;
  parentInstanceId?: string;
  loopIteration?: number;
  approverHistory?: string[];
}

export interface ParseError {
  message: string;
  path?: string;
  line?: number;
  column?: number;
  severity?: "error" | "warning";
}

export interface ParseResult {
  def?: WorkflowDef;
  errors: ParseError[];
}

export interface EvalContext {
  steps: Record<string, StepState>;
  args: Record<string, unknown>;
  env?: Record<string, string>;
  loop?: {
    iteration: number;
    stdout?: string;
    json?: unknown;
  };
}

export interface WorkflowAuditEntry {
  timestamp: string;
  userName: string;
  agentId: string;
  workflowName: string;
  instanceId: string;
  stepId?: string;
  event:
    | "instance_started"
    | "instance_completed"
    | "instance_failed"
    | "instance_cancelled"
    | "step_started"
    | "step_completed"
    | "step_failed"
    | "step_skipped"
    | "approval_requested"
    | "approval_granted"
    | "approval_denied"
    | "approval_timeout"
    | "trigger_skipped";
  status?: "ok" | "error" | "info";
  summary?: string;
  metadata?: Record<string, unknown>;
}
