// Workflow trigger reconciliation. Walks every agent's workflows/ dir,
// surfaces cron/at triggers so the scheduler can register CronJobs that
// invoke engine.runByName.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { listWorkflows } from "./storage.js";
import type { WorkflowDef } from "./types.js";

export interface WorkflowTriggerEntry {
  userName: string;
  agentId: string;
  workflowName: string;
  description?: string;
  cron?: string;
  at?: string;
  every?: string;
  timezone?: string;
  staggerMs?: number;
  webhook?: string;
  event?: string;
}

export function loadAllWorkflowTriggers(): WorkflowTriggerEntry[] {
  const out: WorkflowTriggerEntry[] = [];
  if (!existsSync(config.usersDir)) return out;
  let userDirs: string[];
  try { userDirs = readdirSync(config.usersDir); } catch { return out; }

  for (const userDir of userDirs) {
    if (userDir.startsWith(".")) continue;
    const agentsDir = join(config.usersDir, userDir, "agents");
    if (!existsSync(agentsDir)) continue;
    let agentDirs: string[];
    try { agentDirs = readdirSync(agentsDir); } catch { continue; }
    for (const agentDir of agentDirs) {
      if (agentDir.startsWith(".")) continue;
      const defs = listWorkflows(userDir, agentDir);
      for (const def of defs) {
        appendTriggers(out, userDir, agentDir, def);
      }
    }
  }
  return out;
}

function appendTriggers(out: WorkflowTriggerEntry[], userName: string, agentId: string, def: WorkflowDef): void {
  const triggers = def.triggers ?? [];
  for (const trigger of triggers) {
    if (!trigger.cron && !trigger.at && !trigger.every && !trigger.webhook && !trigger.event) continue;
    out.push({
      userName,
      agentId,
      workflowName: def.name,
      description: def.description,
      cron: trigger.cron,
      at: trigger.at,
      every: trigger.every,
      timezone: trigger.timezone,
      staggerMs: trigger.staggerMs,
      webhook: trigger.webhook,
      event: trigger.event,
    });
  }
}

export function fingerprintWorkflowTriggers(entries: WorkflowTriggerEntry[]): string[] {
  return entries.map((e) => {
    const ts = e.cron || e.at || e.every || e.webhook || e.event || "";
    const tz = e.timezone || "";
    return `workflow:${e.userName}:${e.agentId}:${e.workflowName}:${ts}:${tz}:${e.staggerMs ?? ""}`;
  });
}
