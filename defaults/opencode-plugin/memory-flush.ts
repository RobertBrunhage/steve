import type { Plugin } from "@opencode-ai/plugin";
import fs from "fs";
import path from "path";

export const MemoryFlushPlugin: Plugin = async ({ client, app }) => {
  const FLUSH_HOUR = 23; // 11 PM — end of day summary
  const DAILY_DIR = "./memory/daily";

  function getDailyPath(): string {
    const date = new Date().toISOString().split("T")[0];
    return path.join(DAILY_DIR, `${date}.md`);
  }

  function saveSummary(summary: string, label: string) {
    const timestamp = new Date().toISOString();
    const entry = `\n## ${label} at ${timestamp}\n${summary}\n---\n`;
    try {
      fs.mkdirSync(path.resolve(DAILY_DIR), { recursive: true });
      fs.appendFileSync(path.resolve(getDailyPath()), entry);
    } catch (err) {
      console.error("Memory flush failed:", err);
    }
  }

  // 1. Save compaction summaries to daily file
  app.on("session.compacted", async (event: any) => {
    const summary = event.data?.summary;
    if (summary) saveSummary(summary, "Compacted");
  });

  // 2. Daily scheduled summarize at FLUSH_HOUR
  let lastFlushDate = "";
  setInterval(async () => {
    const now = new Date();
    const today = now.toISOString().split("T")[0];
    if (now.getHours() === FLUSH_HOUR && lastFlushDate !== today) {
      lastFlushDate = today;
      console.log("Triggering daily memory flush...");
      try {
        await client.session.summarize({ path: { id: "current" } });
      } catch (err) {
        console.error("Daily flush failed:", err);
      }
    }
  }, 60_000); // Check every minute

  // 3. Inject memory-save instruction before compaction
  return {
    "experimental.session.compacting": async (input: any, output: any) => {
      output.context.push(
        "IMPORTANT: Before this conversation is compacted, save any important decisions, " +
        "preferences, facts, or action items to memory/MEMORY.md. " +
        "Save a brief summary of today's key topics to " + getDailyPath() + ". " +
        "Only save what matters — skip trivial exchanges."
      );
    },
  };
};
