// YAML → typed WorkflowDef. Uses the `yaml` package's Document API so we can
// surface line/column for validation errors (agents writing workflows need
// pinpointable feedback they can self-correct from).

import { createHash } from "node:crypto";
import { Document, isMap, isPair, isSeq, isScalar, LineCounter, parseDocument } from "yaml";
import type {
  ApprovalStep,
  CrossAgentStep,
  LlmStep,
  ParseError,
  ParseResult,
  PipelineStep,
  RunStep,
  ScriptStep,
  Step,
  SubWorkflowStep,
  Trigger,
  WaitStep,
  WorkflowDef,
} from "./types.js";

const KNOWN_TOP_LEVEL = new Set([
  "name",
  "description",
  "args",
  "triggers",
  "env",
  "condition",
  "concurrency",
  "steps",
  "approval_defaults",
  "approvalDefaults",
]);

const KNOWN_STEP_KEYS = new Set([
  "id",
  "name",
  "type",
  "when",
  "condition",
  "on_error",
  "onError",
  "retry",
  "env",
  // type-specific keys (validated per step):
  "run",
  "script",
  "args",
  "timeout_ms",
  "timeoutMs",
  "cwd",
  "stdin",
  "llm",
  "prompt",
  "isolated",
  "return",
  "pipeline",
  "input",
  "approval",
  "reason",
  "required_approver",
  "requiredApprover",
  "require_different_approver",
  "requireDifferentApprover",
  "buttons",
  "workflow",
  "lobster",
  "loop",
  "cross_agent",
  "crossAgent",
  "agent",
  "user",
  "mode",
  "wait",
  "for_ms",
  "forMs",
  "until",
  "poll_ms",
  "pollMs",
]);

class Ctx {
  readonly errors: ParseError[] = [];
  readonly counter: LineCounter;
  constructor(counter: LineCounter) {
    this.counter = counter;
  }
  err(message: string, range: readonly [number, number, number] | undefined, path?: string): void {
    let line: number | undefined;
    let column: number | undefined;
    if (range) {
      const pos = this.counter.linePos(range[0]);
      line = pos.line;
      column = pos.col;
    }
    this.errors.push({ message, path, line, column, severity: "error" });
  }
}

function getNodeRange(node: unknown): readonly [number, number, number] | undefined {
  if (node && typeof node === "object" && "range" in node) {
    const range = (node as { range?: readonly [number, number, number] | null }).range;
    return range ?? undefined;
  }
  return undefined;
}

function readScalar(node: unknown): unknown {
  if (isScalar(node)) return node.value;
  return undefined;
}

function readMap(node: unknown, ctx: Ctx, path: string): Record<string, unknown> | null {
  if (!isMap(node)) return null;
  const out: Record<string, unknown> = {};
  for (const item of node.items) {
    if (!isPair(item)) continue;
    const key = readScalar(item.key);
    if (typeof key !== "string") continue;
    out[key] = readValue(item.value, ctx, `${path}.${key}`);
  }
  return out;
}

function readSeq(node: unknown, ctx: Ctx, path: string): unknown[] | null {
  if (!isSeq(node)) return null;
  return node.items.map((item, i) => readValue(item, ctx, `${path}[${i}]`));
}

function readValue(node: unknown, ctx: Ctx, path: string): unknown {
  if (node === null || node === undefined) return null;
  if (isScalar(node)) return node.value;
  if (isMap(node)) return readMap(node, ctx, path);
  if (isSeq(node)) return readSeq(node, ctx, path);
  return null;
}

function parseTriggers(raw: unknown, ctx: Ctx): Trigger[] {
  if (!Array.isArray(raw)) return [];
  const triggers: Trigger[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const t = entry as Record<string, unknown>;
    const trigger: Trigger = {};
    if (typeof t.cron === "string") trigger.cron = t.cron;
    if (typeof t.at === "string") trigger.at = t.at;
    if (typeof t.every === "string") trigger.every = t.every;
    if (typeof t.webhook === "string") trigger.webhook = t.webhook;
    else if (t.webhook === true) trigger.webhook = "true";
    if (typeof t.event === "string") trigger.event = t.event;
    if (typeof t.timezone === "string") trigger.timezone = t.timezone;
    if (t.manual === true) trigger.manual = true;
    if (!trigger.cron && !trigger.at && !trigger.every && !trigger.webhook && !trigger.event && !trigger.manual) {
      ctx.errors.push({ message: "trigger must declare one of: cron, at, every, webhook, event, manual", severity: "error" });
    }
    triggers.push(trigger);
  }
  return triggers;
}

function readNumberLike(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (!Number.isNaN(n)) return n;
  }
  return undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === "string");
}

function parseStep(raw: unknown, idx: number, ctx: Ctx, range?: readonly [number, number, number]): Step | null {
  if (!raw || typeof raw !== "object") {
    ctx.err(`step ${idx} must be a map`, range, `steps[${idx}]`);
    return null;
  }
  const r = raw as Record<string, unknown>;

  const id = typeof r.id === "string" ? r.id : `step_${idx + 1}`;
  const base = {
    id,
    name: typeof r.name === "string" ? r.name : undefined,
    when: typeof r.when === "string" ? r.when : typeof r.condition === "string" ? r.condition : undefined,
    condition: typeof r.condition === "string" ? r.condition : undefined,
    onError: typeof (r.on_error ?? r.onError) === "string" ? (r.on_error ?? r.onError) as "stop" | "continue" | "skip_rest" : undefined,
    retry: parseRetry(r.retry),
    env: r.env && typeof r.env === "object" && !Array.isArray(r.env) ? r.env as Record<string, string> : undefined,
  };

  // detect step type by which key is present
  if (typeof r.run === "string") {
    const step: RunStep = {
      ...base,
      type: "run",
      run: r.run,
      timeoutMs: readNumberLike(r.timeout_ms ?? r.timeoutMs),
      cwd: typeof r.cwd === "string" ? r.cwd : undefined,
      stdin: typeof r.stdin === "string" ? r.stdin : undefined,
    };
    return step;
  }
  if (typeof r.script === "string") {
    const step: ScriptStep = {
      ...base,
      type: "script",
      script: r.script,
      args: readStringArray(r.args),
      timeoutMs: readNumberLike(r.timeout_ms ?? r.timeoutMs),
    };
    return step;
  }
  if (r.llm && typeof r.llm === "object" && !Array.isArray(r.llm)) {
    const llm = r.llm as Record<string, unknown>;
    const step: LlmStep = {
      ...base,
      type: "llm",
      prompt: typeof llm.prompt === "string" ? llm.prompt : "",
      isolated: llm.isolated === false ? false : true,
      return: llm.return === "json" ? "json" : "stdout",
    };
    if (!step.prompt) ctx.err(`step ${id}: llm.prompt is required`, range, `steps[${idx}].llm`);
    return step;
  }
  if (typeof r.pipeline === "string") {
    // Detect Lobster-style "pipeline: llm.invoke --prompt ..." and map to llm:
    if (r.pipeline.startsWith("llm.invoke")) {
      const promptMatch = r.pipeline.match(/--prompt\s+("[^"]*"|'[^']*'|\S+)/);
      const prompt = promptMatch ? promptMatch[1].replace(/^["']|["']$/g, "") : "";
      const step: LlmStep = {
        ...base,
        type: "llm",
        prompt,
        isolated: true,
        return: "stdout",
      };
      return step;
    }
    const step: PipelineStep = {
      ...base,
      type: "pipeline",
      pipeline: r.pipeline,
      input: typeof r.input === "string" ? r.input : undefined,
    };
    return step;
  }
  if (r.approval && typeof r.approval === "object" && !Array.isArray(r.approval)) {
    const a = r.approval as Record<string, unknown>;
    const step: ApprovalStep = {
      ...base,
      type: "approval",
      reason: typeof a.reason === "string" ? a.reason : typeof r.reason === "string" ? r.reason : "Approval required",
      requiredApprover: typeof (a.required_approver ?? a.requiredApprover) === "string" ? (a.required_approver ?? a.requiredApprover) as string : undefined,
      requireDifferentApprover: a.require_different_approver === true || a.requireDifferentApprover === true,
      timeoutMs: readNumberLike(a.timeout_ms ?? a.timeoutMs),
      buttons: Array.isArray(a.buttons) ? (a.buttons as unknown[]).map((row) => readStringArray(row) || []) : undefined,
    };
    return step;
  }
  // workflow: / lobster: (sub-workflow)
  const subName = typeof r.workflow === "string" ? r.workflow : typeof r.lobster === "string" ? r.lobster : undefined;
  if (subName) {
    const loop = r.loop && typeof r.loop === "object" && !Array.isArray(r.loop) ? r.loop as Record<string, unknown> : undefined;
    const step: SubWorkflowStep = {
      ...base,
      type: "workflow",
      workflow: subName,
      args: r.args && typeof r.args === "object" && !Array.isArray(r.args) ? r.args as Record<string, unknown> : undefined,
      loop: loop ? {
        maxIterations: readNumberLike(loop.max_iterations ?? loop.maxIterations) ?? 1,
        condition: typeof loop.condition === "string" ? loop.condition : undefined,
      } : undefined,
    };
    return step;
  }
  // cross_agent
  const ca = r.cross_agent ?? r.crossAgent;
  if (ca && typeof ca === "object" && !Array.isArray(ca)) {
    const x = ca as Record<string, unknown>;
    const step: CrossAgentStep = {
      ...base,
      type: "cross_agent",
      agent: typeof x.agent === "string" ? x.agent : "",
      workflow: typeof x.workflow === "string" ? x.workflow : "",
      user: typeof x.user === "string" ? x.user : undefined,
      args: x.args && typeof x.args === "object" && !Array.isArray(x.args) ? x.args as Record<string, unknown> : undefined,
      mode: x.mode === "async" ? "async" : "sync",
      timeoutMs: readNumberLike(x.timeout_ms ?? x.timeoutMs),
    };
    if (!step.agent) ctx.err(`step ${id}: cross_agent.agent is required`, range, `steps[${idx}].cross_agent`);
    if (!step.workflow) ctx.err(`step ${id}: cross_agent.workflow is required`, range, `steps[${idx}].cross_agent`);
    return step;
  }
  if (r.wait && typeof r.wait === "object" && !Array.isArray(r.wait)) {
    const w = r.wait as Record<string, unknown>;
    const step: WaitStep = {
      ...base,
      type: "wait",
      forMs: readNumberLike(w.for_ms ?? w.forMs),
      until: typeof w.until === "string" ? w.until : undefined,
      pollMs: readNumberLike(w.poll_ms ?? w.pollMs),
      timeoutMs: readNumberLike(w.timeout_ms ?? w.timeoutMs),
    };
    return step;
  }

  ctx.err(`step ${id}: unable to determine step type (expected one of: run, script, llm, pipeline, approval, workflow, cross_agent, wait)`, range, `steps[${idx}]`);
  return null;
}

function parseRetry(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const max = readNumberLike(r.max);
  if (max === undefined) return undefined;
  return {
    max,
    backoff: r.backoff === "exponential" ? "exponential" as const : r.backoff === "linear" ? "linear" as const : "none" as const,
    delayMs: readNumberLike(r.delay_ms ?? r.delayMs),
    maxDelayMs: readNumberLike(r.max_delay_ms ?? r.maxDelayMs),
    jitter: r.jitter === true,
  };
}

function checkUnknownKeys(node: unknown, allowed: Set<string>, ctx: Ctx, path: string): void {
  if (!isMap(node)) return;
  for (const item of node.items) {
    if (!isPair(item)) continue;
    const key = readScalar(item.key);
    if (typeof key !== "string") continue;
    if (!allowed.has(key)) {
      ctx.errors.push({
        message: `unknown key '${key}'`,
        path: `${path}.${key}`,
        severity: "warning",
      });
    }
  }
}

export function parseWorkflow(yamlText: string, sourcePath?: string): ParseResult {
  const counter = new LineCounter();
  let doc: Document.Parsed;
  try {
    doc = parseDocument(yamlText, { lineCounter: counter, prettyErrors: true });
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err), severity: "error" }] };
  }
  const ctx = new Ctx(counter);
  for (const yamlErr of doc.errors) {
    ctx.errors.push({
      message: yamlErr.message,
      line: yamlErr.linePos?.[0]?.line,
      column: yamlErr.linePos?.[0]?.col,
      severity: "error",
    });
  }
  if (!doc.contents) {
    return { errors: ctx.errors };
  }
  if (!isMap(doc.contents)) {
    ctx.err("workflow root must be a YAML map", getNodeRange(doc.contents));
    return { errors: ctx.errors };
  }
  checkUnknownKeys(doc.contents, KNOWN_TOP_LEVEL, ctx, "");

  const obj = readMap(doc.contents, ctx, "") || {};
  const name = typeof obj.name === "string" ? obj.name : "";
  if (!name) ctx.err("workflow.name is required", getNodeRange(doc.contents), "name");

  const stepsNode = doc.contents.get("steps", true);
  const steps: Step[] = [];
  if (isSeq(stepsNode)) {
    stepsNode.items.forEach((item, i) => {
      // Validate keys on each step map
      checkUnknownKeys(item, KNOWN_STEP_KEYS, ctx, `steps[${i}]`);
      const parsed = parseStep(readValue(item, ctx, `steps[${i}]`), i, ctx, getNodeRange(item));
      if (parsed) steps.push(parsed);
    });
  } else {
    ctx.err("workflow.steps must be a sequence", getNodeRange(stepsNode));
  }

  // Enforce unique step IDs
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.id)) ctx.err(`duplicate step id '${step.id}'`, undefined, `steps`);
    seen.add(step.id);
  }

  const def: WorkflowDef = {
    name,
    description: typeof obj.description === "string" ? obj.description : undefined,
    args: obj.args && typeof obj.args === "object" && !Array.isArray(obj.args) ? obj.args as WorkflowDef["args"] : undefined,
    triggers: parseTriggers(obj.triggers, ctx),
    env: obj.env && typeof obj.env === "object" && !Array.isArray(obj.env) ? obj.env as Record<string, string> : undefined,
    condition: typeof obj.condition === "string" ? obj.condition : undefined,
    concurrency: obj.concurrency && typeof obj.concurrency === "object" && !Array.isArray(obj.concurrency)
      ? parseConcurrency(obj.concurrency as Record<string, unknown>)
      : undefined,
    steps,
    approvalDefaults: parseApprovalDefaults(obj.approval_defaults ?? obj.approvalDefaults),
    sourcePath,
    sourceYaml: yamlText,
  };

  const fatal = ctx.errors.filter((e) => e.severity !== "warning");
  return { def: fatal.length === 0 ? def : undefined, errors: ctx.errors };
}

function parseConcurrency(raw: Record<string, unknown>) {
  const mode = raw.mode === "skip" || raw.mode === "parallel" ? raw.mode : "queue";
  const limit = readNumberLike(raw.limit);
  return { mode: mode as "queue" | "skip" | "parallel", limit };
}

function parseApprovalDefaults(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  return {
    requiredApprover: typeof (r.required_approver ?? r.requiredApprover) === "string" ? r.required_approver as string : undefined,
    requireDifferentApprover: r.require_different_approver === true || r.requireDifferentApprover === true,
    timeoutMs: readNumberLike(r.timeout_ms ?? r.timeoutMs),
  };
}

export function workflowVersion(yamlText: string): string {
  return createHash("sha256").update(yamlText).digest("hex").slice(0, 16);
}
