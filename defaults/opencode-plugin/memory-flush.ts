import type { Plugin } from "@opencode-ai/plugin";
import fs from "fs";
import path from "path";

const MEMORY_DIR = "./memory/daily";
const KELLIX_AGENT_PATH = path.resolve(".opencode/agents/kellix.md");
const LEGACY_STEVE_AGENT_PATH = path.resolve(".opencode/agents/steve.md");

function readKellixUser(): string | null {
  try {
    const agentPath = fs.existsSync(KELLIX_AGENT_PATH) ? KELLIX_AGENT_PATH : LEGACY_STEVE_AGENT_PATH;
    const content = fs.readFileSync(agentPath, "utf-8");
    const match = content.match(/^Current (?:Kellix|Steve) user: (.+)$/m);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function isPrimaryKellixSessionTitle(title: string, userName: string | null): boolean {
  if (!title.startsWith("Kellix - ") && !title.startsWith("Steve - ")) return false;
  if (title.includes("(isolated)")) return false;
  if (!userName) return true;
  return title.trim() === `Kellix - ${userName}` || title.trim() === `Steve - ${userName}`;
}

async function shouldRecordCompaction(client: any, sessionID: string, userName: string | null): Promise<boolean> {
  try {
    const res = await client.session.get({ path: { id: sessionID } });
    const title = String(res.data?.title || "");
    return isPrimaryKellixSessionTitle(title, userName);
  } catch {
    return false;
  }
}

function todayFile(): string {
  return path.join(MEMORY_DIR, `${new Date().toISOString().split("T")[0]}.md`);
}

function appendToDaily(text: string, label: string) {
  const entry = `\n## ${label} — ${new Date().toLocaleTimeString()}\n${text}\n---\n`;
  try {
    fs.mkdirSync(path.resolve(MEMORY_DIR), { recursive: true });
    fs.appendFileSync(path.resolve(todayFile()), entry);
    console.log(`Memory flush: saved to ${todayFile()}`);
  } catch (err) {
    console.error("Memory flush failed:", err);
  }
}

export const MemoryFlushPlugin: Plugin = async ({ client }: { client: any }) => {
  const userName = readKellixUser();

  return {
    event: async ({ event }: { event: any }) => {
      if (event.type === "session.compacted") {
        const sessionID = (event as any).properties?.sessionID;
        if (!sessionID) return;
        if (!(await shouldRecordCompaction(client, sessionID, userName))) return;

        try {
          // Fetch all messages — the full history is preserved, with a
          // CompactionPart marker as the divider. Everything AFTER the
          // compaction marker is the summary that becomes the new context.
          const res = await client.session.messages({
            path: { id: sessionID },
          });

          if (!res.data) return;

          const messages = res.data as Array<{
            info: { role: string };
            parts: Array<{ type: string; text?: string }>;
          }>;

          // Find the compaction marker, then collect text from messages after it
          let foundCompaction = false;
          const summaryParts: string[] = [];

          for (const msg of messages) {
            // Check if this message contains the compaction marker
            if (!foundCompaction) {
              const hasCompaction = msg.parts.some((p) => p.type === "compaction");
              if (hasCompaction) {
                foundCompaction = true;
              }
              continue;
            }

            // After the compaction marker — collect assistant text parts
            if (msg.info.role !== "assistant") continue;
            for (const part of msg.parts) {
              if (part.type === "text" && part.text) {
                summaryParts.push(part.text);
              }
            }
          }

          if (summaryParts.length > 0) {
            appendToDaily(summaryParts.join("\n\n"), "Session summary");
          } else {
            console.log("session.compacted: no text parts found after compaction marker");
          }
        } catch (err) {
          console.error("Failed to fetch session messages after compaction:", err);
        }
      }
    },

    // Guide compaction to produce a useful summary
    "experimental.session.compacting": async (_input: any, output: any) => {
      output.context.push(
        "Summarize this session as a concise daily note for future reference. " +
        "Prefer short markdown bullets under clear headings like Decisions, Commitments, Open Loops, and Important Facts when relevant. " +
        "Only include concrete things that matter later. Skip chit-chat, repeated planning, and tool noise. Omit empty sections."
      );
    },
  };
};
