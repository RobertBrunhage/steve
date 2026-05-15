// Workflow audit log. Append-only JSONL per user, mirrors src/activity.ts:32-37.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { toUserSlug } from "../users.js";
import type { WorkflowAuditEntry } from "./types.js";

export function appendWorkflowAudit(dataDir: string, entry: WorkflowAuditEntry): void {
  const dir = join(dataDir, "audit", "workflows");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${toUserSlug(entry.userName)}.jsonl`);
  try {
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch {
    // best-effort; never crash a workflow for audit issues
  }
}
