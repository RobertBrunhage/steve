import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface RunScriptAuditEntry {
  timestamp: string;
  userName: string;
  script: string;
  status: "ok" | "error";
  durationMs: number;
  secretKeys: string[];
  usedManifest: boolean;
  redactionCount: number;
}

export function getRunScriptAuditPath(dataDir: string): string {
  return join(dataDir, "audit", "run-script.jsonl");
}

export function appendRunScriptAudit(dataDir: string, entry: RunScriptAuditEntry): void {
  const filePath = getRunScriptAuditPath(dataDir);
  mkdirSync(join(dataDir, "audit"), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf-8");
}
