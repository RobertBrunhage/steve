// Workflow execution engine. Per-instance async Promise chain; per-workflow
// concurrency queue; in-memory pendingApprovals map mapping instanceId →
// resolve fn waited on by an approval step. State is persisted on every
// transition so we can rehydrate after a kellix restart.

import { randomUUID } from "node:crypto";
import type { Brain } from "../brain/index.js";
import type { Channel } from "../channels/index.js";
import type { Vault } from "../vault/index.js";
import { appendWorkflowAudit } from "./audit.js";
import { coerceBool, evaluate, interpolate } from "./expressions.js";
import { parseWorkflow, workflowVersion } from "./parser.js";
import {
  findWaitingByAgent,
  listInstances,
  readWorkflow,
  readWorkflowRaw,
  scanRunnableInstances,
  writeInstance,
} from "./storage.js";
import type {
  EvalContext,
  ParseError,
  RunStatus,
  Step,
  StepState,
  WorkflowDef,
  WorkflowInstance,
} from "./types.js";

export interface RunnerDeps {
  brain: Brain;
  channel: Channel;
  vault: Vault | null;
  dataDir: string;
  projectRoot: string;
}

export interface RunOptions {
  args?: Record<string, unknown>;
  triggerKind?: WorkflowInstance["trigger"]["kind"];
  triggerMeta?: Record<string, unknown>;
  parentInstanceId?: string;
}

export interface StepResult {
  status: "ok" | "error" | "skipped" | "waiting";
  stdout?: string;
  json?: unknown;
  error?: string;
  approved?: boolean;
  approvedBy?: string;
  response?: string;
}

export interface StepHandler {
  run(step: Step, instance: WorkflowInstance, runtime: StepRuntime): Promise<StepResult>;
}

export interface StepRuntime {
  deps: RunnerDeps;
  runner: WorkflowRunner;
  ctx: EvalContext;
  interpolate: (template: string) => string;
  evaluate: (expr: string) => unknown;
  /** Pause until resumed by an external event (approval, async wait). */
  pauseForResume<T = unknown>(stepId: string, waiting: WorkflowInstance["waiting"]): Promise<{ response?: string; approvedBy?: string; payload?: T }>;
}

interface PendingApproval {
  instanceId: string;
  stepId: string;
  resolve: (resp: { response?: string; approvedBy?: string }) => void;
  reject: (err: Error) => void;
  deadline?: number;
  timer?: ReturnType<typeof setTimeout>;
}

export class WorkflowRunner {
  private readonly deps: RunnerDeps;
  private readonly stepHandlers = new Map<Step["type"], StepHandler>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly workflowQueues = new Map<string, Promise<unknown>>();

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  registerStepHandler(type: Step["type"], handler: StepHandler): void {
    this.stepHandlers.set(type, handler);
  }

  getDeps(): RunnerDeps {
    return this.deps;
  }

  /** Spin up engine: rehydrate persisted waiting_approval instances. */
  rehydrate(): void {
    const targets = scanRunnableInstances();
    for (const { instance } of targets) {
      if (instance.status === "running") {
        instance.status = "error";
        instance.error = {
          stepId: instance.currentStepId,
          message: "Workflow interrupted by kellix restart",
          code: "interrupted_at_boot",
        };
        instance.finishedAt = new Date().toISOString();
        writeInstance(instance);
        appendWorkflowAudit(this.deps.dataDir, {
          timestamp: instance.finishedAt,
          userName: instance.userName,
          agentId: instance.agentId,
          workflowName: instance.workflowName,
          instanceId: instance.id,
          event: "instance_failed",
          status: "error",
          summary: "Interrupted at boot",
        });
        continue;
      }
      // For waiting_approval: re-attach a pending record + re-arm timeout
      if (instance.status === "waiting_approval" && instance.waiting) {
        this.rearmApprovalTimeout(instance);
      }
    }
  }

  private rearmApprovalTimeout(instance: WorkflowInstance): void {
    if (!instance.waiting?.deadline) return;
    const deadline = new Date(instance.waiting.deadline).getTime();
    const now = Date.now();
    if (deadline <= now) {
      this.handleApprovalTimeout(instance);
      return;
    }
    const pending: PendingApproval = {
      instanceId: instance.id,
      stepId: instance.waiting.stepId,
      resolve: () => {},
      reject: () => {},
      deadline,
      timer: setTimeout(() => this.handleApprovalTimeout(instance), deadline - now),
    };
    this.pendingApprovals.set(instance.id, pending);
  }

  private handleApprovalTimeout(instance: WorkflowInstance): void {
    const stored = this.pendingApprovals.get(instance.id);
    if (stored?.timer) clearTimeout(stored.timer);
    this.pendingApprovals.delete(instance.id);
    instance.status = "error";
    instance.error = { stepId: instance.waiting?.stepId, message: "Approval timed out", code: "approval_timeout" };
    instance.finishedAt = new Date().toISOString();
    instance.waiting = undefined;
    writeInstance(instance);
    appendWorkflowAudit(this.deps.dataDir, {
      timestamp: instance.finishedAt,
      userName: instance.userName,
      agentId: instance.agentId,
      workflowName: instance.workflowName,
      instanceId: instance.id,
      event: "approval_timeout",
      status: "error",
    });
  }

  /** Attempt to resume an approval. Returns true if the resume was consumed. */
  resume(input: { instanceId: string; response?: string; approvedBy?: string }): boolean {
    const pending = this.pendingApprovals.get(input.instanceId);
    if (!pending) return false;
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingApprovals.delete(input.instanceId);
    pending.resolve({ response: input.response, approvedBy: input.approvedBy });
    return true;
  }

  /** Try to use a plain text Telegram reply as an approval response. */
  tryConsumeAsApprovalReply(userName: string, agentId: string, text: string, approvedBy?: string): boolean {
    const candidates = findWaitingByAgent(userName, agentId);
    if (candidates.length !== 1) return false;
    return this.resume({ instanceId: candidates[0].id, response: text, approvedBy: approvedBy || userName });
  }

  cancel(instanceId: string): boolean {
    const pending = this.pendingApprovals.get(instanceId);
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error("cancelled"));
      this.pendingApprovals.delete(instanceId);
    }
    // Note: cancelling an instance mid-shell-step is best-effort.
    return true;
  }

  async runByName(userName: string, agentId: string, workflowName: string, opts: RunOptions = {}): Promise<WorkflowInstance> {
    const def = readWorkflow(userName, agentId, workflowName);
    if (!def) throw new Error(`workflow not found: ${userName}/${agentId}/${workflowName}`);
    return this.run(userName, agentId, def, opts);
  }

  async run(userName: string, agentId: string, def: WorkflowDef, opts: RunOptions = {}): Promise<WorkflowInstance> {
    const queueKey = `${userName}:${agentId}:${def.name}`;
    const mode = def.concurrency?.mode ?? "queue";

    if (mode === "skip" && this.isRunningOrWaiting(userName, agentId, def.name)) {
      appendWorkflowAudit(this.deps.dataDir, {
        timestamp: new Date().toISOString(),
        userName,
        agentId,
        workflowName: def.name,
        instanceId: "",
        event: "trigger_skipped",
        status: "info",
        summary: "skip mode: previous instance still running",
      });
      throw new Error("skipped: previous instance still running");
    }

    const exec = () => this.execute(userName, agentId, def, opts);
    if (mode === "parallel") {
      return exec();
    }
    const prev = this.workflowQueues.get(queueKey) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(exec);
    this.workflowQueues.set(queueKey, next);
    return next;
  }

  private isRunningOrWaiting(userName: string, agentId: string, workflowName: string): boolean {
    const recent = listInstances(userName, agentId, { workflowName, limit: 20 });
    return recent.some((i) => i.status === "running" || i.status === "waiting_approval");
  }

  private async execute(userName: string, agentId: string, def: WorkflowDef, opts: RunOptions): Promise<WorkflowInstance> {
    const yamlText = def.sourceYaml || readWorkflowRaw(userName, agentId, def.name) || "";
    const instance: WorkflowInstance = {
      id: randomUUID(),
      userName,
      agentId,
      workflowName: def.name,
      workflowVersion: workflowVersion(yamlText),
      status: "running",
      trigger: {
        kind: opts.triggerKind ?? "manual",
        meta: opts.triggerMeta,
      },
      args: opts.args ?? {},
      steps: {},
      startedAt: new Date().toISOString(),
      parentInstanceId: opts.parentInstanceId,
      approverHistory: [],
    };
    writeInstance(instance);
    appendWorkflowAudit(this.deps.dataDir, {
      timestamp: instance.startedAt,
      userName,
      agentId,
      workflowName: def.name,
      instanceId: instance.id,
      event: "instance_started",
      status: "info",
      summary: opts.triggerKind ? `triggered: ${opts.triggerKind}` : undefined,
    });

    try {
      // Top-level condition
      if (def.condition) {
        const ctx: EvalContext = { steps: instance.steps, args: instance.args, env: def.env };
        if (!coerceBool(evaluate(def.condition, ctx))) {
          instance.status = "ok";
          instance.finishedAt = new Date().toISOString();
          writeInstance(instance);
          return instance;
        }
      }

      for (const step of def.steps) {
        instance.currentStepId = step.id;
        const stepState: StepState = { id: step.id, status: "pending", attempt: 0 };
        instance.steps[step.id] = stepState;

        const ctx: EvalContext = { steps: instance.steps, args: instance.args, env: def.env };
        const when = step.when || step.condition;
        if (when) {
          try {
            if (!coerceBool(evaluate(when, ctx))) {
              stepState.status = "skipped";
              stepState.finishedAt = new Date().toISOString();
              writeInstance(instance);
              continue;
            }
          } catch (err) {
            stepState.status = "error";
            stepState.error = err instanceof Error ? err.message : String(err);
            stepState.finishedAt = new Date().toISOString();
            writeInstance(instance);
            if ((step.onError ?? "stop") === "continue") continue;
            if (step.onError === "skip_rest") break;
            throw err;
          }
        }

        const result = await this.runStepWithRetry(step, instance);
        stepState.status = result.status === "waiting" ? "waiting" : result.status;
        stepState.finishedAt = new Date().toISOString();
        stepState.stdout = result.stdout;
        stepState.json = result.json;
        stepState.error = result.error;
        stepState.approved = result.approved;
        stepState.approvedBy = result.approvedBy;
        stepState.response = result.response;
        writeInstance(instance);

        if (result.status === "error") {
          appendWorkflowAudit(this.deps.dataDir, {
            timestamp: stepState.finishedAt!,
            userName,
            agentId,
            workflowName: def.name,
            instanceId: instance.id,
            stepId: step.id,
            event: "step_failed",
            status: "error",
            summary: result.error,
          });
          const policy = step.onError ?? "stop";
          if (policy === "continue") continue;
          if (policy === "skip_rest") break;
          instance.status = "error";
          instance.error = { stepId: step.id, message: result.error ?? "step failed" };
          instance.finishedAt = new Date().toISOString();
          writeInstance(instance);
          appendWorkflowAudit(this.deps.dataDir, {
            timestamp: instance.finishedAt!,
            userName,
            agentId,
            workflowName: def.name,
            instanceId: instance.id,
            event: "instance_failed",
            status: "error",
          });
          return instance;
        }

        appendWorkflowAudit(this.deps.dataDir, {
          timestamp: stepState.finishedAt!,
          userName,
          agentId,
          workflowName: def.name,
          instanceId: instance.id,
          stepId: step.id,
          event: result.status === "skipped" ? "step_skipped" : "step_completed",
          status: result.status === "ok" ? "ok" : "info",
        });
      }

      instance.currentStepId = undefined;
      instance.status = "ok";
      instance.finishedAt = new Date().toISOString();
      const lastStep = def.steps[def.steps.length - 1];
      if (lastStep && instance.steps[lastStep.id]) {
        instance.output = instance.steps[lastStep.id].json ?? instance.steps[lastStep.id].stdout;
      }
      writeInstance(instance);
      appendWorkflowAudit(this.deps.dataDir, {
        timestamp: instance.finishedAt,
        userName,
        agentId,
        workflowName: def.name,
        instanceId: instance.id,
        event: "instance_completed",
        status: "ok",
      });
      return instance;
    } catch (err) {
      instance.status = "error";
      instance.error = { stepId: instance.currentStepId, message: err instanceof Error ? err.message : String(err) };
      instance.finishedAt = new Date().toISOString();
      writeInstance(instance);
      appendWorkflowAudit(this.deps.dataDir, {
        timestamp: instance.finishedAt,
        userName,
        agentId,
        workflowName: def.name,
        instanceId: instance.id,
        event: "instance_failed",
        status: "error",
        summary: instance.error.message,
      });
      return instance;
    }
  }

  private async runStepWithRetry(step: Step, instance: WorkflowInstance): Promise<StepResult> {
    const handler = this.stepHandlers.get(step.type);
    if (!handler) {
      return { status: "error", error: `no handler registered for step type '${step.type}'` };
    }
    const max = step.retry?.max ?? 0;
    let attempt = 0;
    let lastError: string | undefined;
    while (true) {
      attempt++;
      const stepState = instance.steps[step.id];
      stepState.status = "running";
      stepState.attempt = attempt;
      stepState.startedAt = new Date().toISOString();
      writeInstance(instance);
      appendWorkflowAudit(this.deps.dataDir, {
        timestamp: stepState.startedAt,
        userName: instance.userName,
        agentId: instance.agentId,
        workflowName: instance.workflowName,
        instanceId: instance.id,
        stepId: step.id,
        event: "step_started",
        status: "info",
        metadata: { attempt },
      });
      const runtime = this.buildRuntime(instance);
      try {
        const result = await handler.run(step, instance, runtime);
        if (result.status === "error" && attempt <= max) {
          lastError = result.error;
          await this.sleepRetry(step.retry, attempt);
          continue;
        }
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt <= max) {
          await this.sleepRetry(step.retry, attempt);
          continue;
        }
        return { status: "error", error: lastError };
      }
    }
  }

  private async sleepRetry(retry: Step["retry"], attempt: number): Promise<void> {
    const delay = retry?.delayMs ?? 1000;
    const max = retry?.maxDelayMs ?? 30000;
    let wait = retry?.backoff === "exponential" ? delay * Math.pow(2, attempt - 1) : retry?.backoff === "linear" ? delay * attempt : delay;
    wait = Math.min(wait, max);
    if (retry?.jitter) wait = wait * (0.5 + Math.random());
    await new Promise((resolve) => setTimeout(resolve, wait));
  }

  private buildRuntime(instance: WorkflowInstance): StepRuntime {
    const ctx: EvalContext = { steps: instance.steps, args: instance.args };
    return {
      deps: this.deps,
      runner: this,
      ctx,
      interpolate: (template: string) => interpolate(template, ctx),
      evaluate: (expr: string) => evaluate(expr, ctx),
      pauseForResume: (stepId, waiting) => this.pauseForResume(instance, stepId, waiting),
    };
  }

  private pauseForResume(instance: WorkflowInstance, stepId: string, waiting: WorkflowInstance["waiting"]): Promise<{ response?: string; approvedBy?: string }> {
    instance.status = "waiting_approval";
    instance.waiting = waiting;
    writeInstance(instance);
    appendWorkflowAudit(this.deps.dataDir, {
      timestamp: new Date().toISOString(),
      userName: instance.userName,
      agentId: instance.agentId,
      workflowName: instance.workflowName,
      instanceId: instance.id,
      stepId,
      event: "approval_requested",
      status: "info",
    });
    return new Promise((resolve, reject) => {
      const deadline = waiting?.deadline ? new Date(waiting.deadline).getTime() : undefined;
      const pending: PendingApproval = {
        instanceId: instance.id,
        stepId,
        resolve: (resp) => {
          // Lift instance state back to running before resolving
          instance.status = "running";
          instance.waiting = undefined;
          writeInstance(instance);
          resolve(resp);
        },
        reject,
        deadline,
      };
      if (deadline) {
        const delta = deadline - Date.now();
        pending.timer = setTimeout(() => {
          this.pendingApprovals.delete(instance.id);
          this.handleApprovalTimeout(instance);
          reject(new Error("approval_timeout"));
        }, Math.max(0, delta));
      }
      this.pendingApprovals.set(instance.id, pending);
    });
  }
}

/**
 * Parse YAML + return validation errors only. Pure check, no side effects.
 */
export function validateWorkflowYaml(yamlText: string): { ok: boolean; errors: ParseError[] } {
  const result = parseWorkflow(yamlText);
  const fatal = result.errors.filter((e) => e.severity !== "warning");
  return { ok: fatal.length === 0 && !!result.def, errors: result.errors };
}
