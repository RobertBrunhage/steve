import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toUserSlug } from "./users.js";

const MAX_ACTIVITY_ENTRIES = 200;

export type ActivityType = "message_received" | "message_sent" | "job" | "script" | "system";

export interface ActivityEntry {
  timestamp: string;
  userName: string;
  type: ActivityType;
  status: "ok" | "error" | "info";
  summary: string;
}

function getActivityDir(dataDir: string): string {
  return join(dataDir, "audit", "activity");
}

export function getUserActivityPath(dataDir: string, userName: string): string {
  return join(getActivityDir(dataDir), `${toUserSlug(userName)}.jsonl`);
}

function trimActivityFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
  if (lines.length <= MAX_ACTIVITY_ENTRIES) return;
  writeFileSync(filePath, `${lines.slice(-MAX_ACTIVITY_ENTRIES).join("\n")}\n`, "utf-8");
}

export function appendUserActivity(dataDir: string, entry: ActivityEntry): void {
  mkdirSync(getActivityDir(dataDir), { recursive: true });
  const filePath = getUserActivityPath(dataDir, entry.userName);
  appendFileSync(filePath, `${JSON.stringify({ ...entry, userName: toUserSlug(entry.userName) })}\n`, "utf-8");
  trimActivityFile(filePath);
}

export function readUserActivity(dataDir: string, userName: string, limit = 8): ActivityEntry[] {
  const filePath = getUserActivityPath(dataDir, userName);
  if (!existsSync(filePath)) return [];

  const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
  return lines
    .slice(-limit)
    .reverse()
    .map((line) => {
      try {
        return JSON.parse(line) as ActivityEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is ActivityEntry => !!entry);
}
