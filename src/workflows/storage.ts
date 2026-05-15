// Disk I/O for workflow definitions and instances. Both live under each
// agent's workspace at users/<u>/agents/<id>/workflows/.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, getUserAgentWorkflowsDir } from "../config.js";
import { toUserSlug } from "../users.js";
import type { WorkflowDef, WorkflowInstance } from "./types.js";
import { parseWorkflow } from "./parser.js";

const WORKFLOW_FILE_SUFFIX = ".workflow.yaml";

export { getUserAgentWorkflowsDir };

function getRunsDir(userName: string, agentId: string): string {
  return join(getUserAgentWorkflowsDir(userName, agentId), ".runs");
}

function getWaitingDir(userName: string, agentId: string): string {
  return join(getUserAgentWorkflowsDir(userName, agentId), ".waiting");
}

function getWorkflowFilePath(userName: string, agentId: string, name: string): string {
  return join(getUserAgentWorkflowsDir(userName, agentId), `${name}${WORKFLOW_FILE_SUFFIX}`);
}

export function listWorkflowFiles(userName: string, agentId: string): string[] {
  const dir = getUserAgentWorkflowsDir(userName, agentId);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(WORKFLOW_FILE_SUFFIX))
      .sort();
  } catch {
    return [];
  }
}

export function listWorkflows(userName: string, agentId: string): WorkflowDef[] {
  const out: WorkflowDef[] = [];
  for (const file of listWorkflowFiles(userName, agentId)) {
    const def = readWorkflow(userName, agentId, file.slice(0, -WORKFLOW_FILE_SUFFIX.length));
    if (def) out.push(def);
  }
  return out;
}

export function readWorkflow(userName: string, agentId: string, name: string): WorkflowDef | null {
  const path = getWorkflowFilePath(userName, agentId, name);
  if (!existsSync(path)) return null;
  try {
    const yamlText = readFileSync(path, "utf-8");
    const result = parseWorkflow(yamlText, path);
    return result.def ?? null;
  } catch {
    return null;
  }
}

export function readWorkflowRaw(userName: string, agentId: string, name: string): string | null {
  const path = getWorkflowFilePath(userName, agentId, name);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

export function writeWorkflow(userName: string, agentId: string, name: string, yamlText: string): string {
  const dir = getUserAgentWorkflowsDir(userName, agentId);
  mkdirSync(dir, { recursive: true });
  const path = getWorkflowFilePath(userName, agentId, name);
  writeFileSync(path, yamlText, "utf-8");
  return path;
}

export function deleteWorkflow(userName: string, agentId: string, name: string): boolean {
  const path = getWorkflowFilePath(userName, agentId, name);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

// --- Instances ----------------------------------------------------------

function instanceDir(userName: string, agentId: string, dateIso: string): string {
  return join(getRunsDir(userName, agentId), dateIso);
}

function instancePath(userName: string, agentId: string, instance: WorkflowInstance): string {
  const dateIso = instance.startedAt.slice(0, 10);
  return join(instanceDir(userName, agentId, dateIso), `${instance.id}.json`);
}

export function writeInstance(instance: WorkflowInstance): void {
  const dir = instanceDir(instance.userName, instance.agentId, instance.startedAt.slice(0, 10));
  mkdirSync(dir, { recursive: true });
  const path = instancePath(instance.userName, instance.agentId, instance);
  writeFileSync(path, `${JSON.stringify(instance, null, 2)}\n`, "utf-8");
  if (instance.status === "waiting_approval") {
    const waitingDir = getWaitingDir(instance.userName, instance.agentId);
    mkdirSync(waitingDir, { recursive: true });
    writeFileSync(join(waitingDir, `${instance.id}.json`), `${JSON.stringify(instance, null, 2)}\n`, "utf-8");
  } else {
    const waitingPath = join(getWaitingDir(instance.userName, instance.agentId), `${instance.id}.json`);
    if (existsSync(waitingPath)) rmSync(waitingPath, { force: true });
  }
}

export function readInstance(userName: string, agentId: string, instanceId: string): WorkflowInstance | null {
  const runsDir = getRunsDir(userName, agentId);
  if (!existsSync(runsDir)) return null;
  try {
    for (const day of readdirSync(runsDir)) {
      const candidate = join(runsDir, day, `${instanceId}.json`);
      if (existsSync(candidate)) {
        return JSON.parse(readFileSync(candidate, "utf-8")) as WorkflowInstance;
      }
    }
  } catch {}
  return null;
}

export function listInstances(userName: string, agentId: string, opts: { workflowName?: string; limit?: number } = {}): WorkflowInstance[] {
  const runsDir = getRunsDir(userName, agentId);
  if (!existsSync(runsDir)) return [];
  const out: WorkflowInstance[] = [];
  try {
    const days = readdirSync(runsDir).sort().reverse();
    for (const day of days) {
      const dayDir = join(runsDir, day);
      const files = readdirSync(dayDir).sort().reverse();
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const instance = JSON.parse(readFileSync(join(dayDir, file), "utf-8")) as WorkflowInstance;
          if (opts.workflowName && instance.workflowName !== opts.workflowName) continue;
          out.push(instance);
          if (opts.limit && out.length >= opts.limit) return out;
        } catch {}
      }
    }
  } catch {}
  return out;
}

export interface RehydrationTarget {
  userName: string;
  agentId: string;
  instance: WorkflowInstance;
}

export function scanRunnableInstances(): RehydrationTarget[] {
  const targets: RehydrationTarget[] = [];
  const usersDir = config.usersDir;
  if (!existsSync(usersDir)) return targets;
  for (const userDir of safeReaddir(usersDir)) {
    if (userDir.startsWith(".")) continue;
    const agentsDir = join(usersDir, userDir, "agents");
    if (!existsSync(agentsDir)) continue;
    for (const agentDir of safeReaddir(agentsDir)) {
      if (agentDir.startsWith(".")) continue;
      const runsDir = join(agentsDir, agentDir, "workflows", ".runs");
      if (!existsSync(runsDir)) continue;
      for (const day of safeReaddir(runsDir)) {
        const dayDir = join(runsDir, day);
        if (!safeIsDir(dayDir)) continue;
        for (const file of safeReaddir(dayDir)) {
          if (!file.endsWith(".json")) continue;
          try {
            const inst = JSON.parse(readFileSync(join(dayDir, file), "utf-8")) as WorkflowInstance;
            if (inst.status === "running" || inst.status === "waiting_approval") {
              targets.push({ userName: toUserSlug(userDir), agentId: toUserSlug(agentDir), instance: inst });
            }
          } catch {}
        }
      }
    }
  }
  return targets;
}

export function findWaitingByAgent(userName: string, agentId: string): WorkflowInstance[] {
  const waitingDir = getWaitingDir(userName, agentId);
  if (!existsSync(waitingDir)) return [];
  const out: WorkflowInstance[] = [];
  for (const file of safeReaddir(waitingDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(waitingDir, file), "utf-8")) as WorkflowInstance);
    } catch {}
  }
  return out;
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

function safeIsDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
