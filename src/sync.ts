import { execSync } from "node:child_process";
import * as p from "@clack/prompts";
import { steveDir } from "./config.js";

function hasChanges(): boolean {
  try {
    const status = execSync("git status --porcelain", {
      cwd: steveDir,
      encoding: "utf-8",
    });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

function hasRemote(): boolean {
  try {
    execSync("git remote get-url origin", { cwd: steveDir, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function sync() {
  if (!hasChanges()) return;

  try {
    execSync('git add -A && git commit -m "Auto-sync"', {
      cwd: steveDir,
      stdio: "ignore",
    });

    if (hasRemote()) {
      execSync("git push", { cwd: steveDir, stdio: "ignore" });
    }
  } catch (err) {
    p.log.warn(`Sync failed: ${err instanceof Error ? err.message : err}`);
  }
}

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // Every 5 minutes

export function startAutoSync() {
  // Initial sync after 30 seconds (let startup settle)
  setTimeout(sync, 30_000);

  // Then every 5 minutes
  setInterval(sync, SYNC_INTERVAL_MS);

  p.log.info("Auto-sync enabled");
}
