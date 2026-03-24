import { readdirSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CronJob } from "cron";
import matter from "gray-matter";
import type { Bot } from "grammy";
import type { Brain } from "./brain/index.js";
import { config } from "./config.js";

function getChatIdForUser(userName: string): number | null {
  // Find the user ID whose name matches
  for (const [id, name] of Object.entries(config.telegram.users)) {
    if (name.toLowerCase() === userName.toLowerCase()) {
      return Number(id);
    }
  }
  return null;
}

interface CronReminder {
  kind: "cron";
  file: string;
  userName: string;
  name: string;
  cron: string;
  prompt: string;
}

interface OneOffReminder {
  kind: "at";
  file: string;
  userName: string;
  name: string;
  at: Date;
  prompt: string;
}

type Reminder = CronReminder | OneOffReminder;

const activeJobs: Map<string, CronJob> = new Map();
const firedOneOffs: Set<string> = new Set();

function loadReminders(): Reminder[] {
  const reminders: Reminder[] = [];
  const memDir = config.memoryDir;

  let users: string[];
  try {
    users = readdirSync(memDir);
  } catch {
    return [];
  }

  for (const userName of users) {
    const reminderDir = join(memDir, userName, "reminders");
    let files: string[];
    try {
      files = readdirSync(reminderDir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }

    for (const file of files) {
      try {
        const raw = readFileSync(join(reminderDir, file), "utf-8");
        const { data } = matter(raw);
        if (!data.prompt) continue;

        const filePath = join(reminderDir, file);

        if (data.cron) {
          reminders.push({
            kind: "cron",
            file: filePath,
            userName,
            name: data.name || file,
            cron: data.cron,
            prompt: data.prompt,
          });
        } else if (data.at) {
          const at = new Date(data.at);
          if (!isNaN(at.getTime())) {
            reminders.push({
              kind: "at",
              file: filePath,
              userName,
              name: data.name || file,
              at,
              prompt: data.prompt,
            });
          }
        }
      } catch (err) {
        console.error(`[Scheduler] Failed to parse ${file}:`, err);
      }
    }
  }

  return reminders;
}

async function fireReminder(
  reminder: Reminder,
  brain: Brain,
  bot: Bot,
) {
  const chatId = getChatIdForUser(reminder.userName);
  if (!chatId) {
    console.warn(`[Scheduler] No chat ID for user "${reminder.userName}", skipping`);
    return;
  }

  console.log(`[Scheduler] Firing reminder "${reminder.name}" for ${reminder.userName}`);

  const reply = await brain.think(
    `REMINDER: ${reminder.prompt}`,
    reminder.userName,
    `reminder-${reminder.userName}`,
  );

  try {
    await bot.api.sendMessage(chatId, reply, { parse_mode: "Markdown" });
  } catch {
    try {
      await bot.api.sendMessage(chatId, reply);
    } catch (err) {
      console.error(`[Scheduler] Failed to send message to ${reminder.userName}:`, err);
    }
  }

  // Delete one-off reminders after firing
  if (reminder.kind === "at") {
    try {
      unlinkSync(reminder.file);
      console.log(`[Scheduler] Deleted one-off reminder: ${reminder.file}`);
    } catch (err) {
      console.error(`[Scheduler] Failed to delete ${reminder.file}:`, err);
    }
  }
}

function checkOneOffs(reminders: OneOffReminder[], brain: Brain, bot: Bot) {
  const now = Date.now();

  for (const reminder of reminders) {
    if (firedOneOffs.has(reminder.file)) continue;
    if (reminder.at.getTime() <= now) {
      firedOneOffs.add(reminder.file);
      fireReminder(reminder, brain, bot);
    }
  }
}

export function startScheduler(brain: Brain, bot: Bot) {
  let oneOffs: OneOffReminder[] = [];
  let lastFingerprint = "";

  function syncReminders(initial = false) {
    const reminders = loadReminders();

    // Build a fingerprint to detect changes
    const fingerprint = reminders
      .map((r) => `${r.file}:${r.kind === "cron" ? r.cron : r.at}`)
      .sort()
      .join("|");

    if (fingerprint === lastFingerprint && !initial) {
      // Nothing changed, just check one-offs
      checkOneOffs(oneOffs, brain, bot);
      return;
    }
    lastFingerprint = fingerprint;

    // Stop all existing cron jobs
    for (const [, job] of activeJobs) {
      job.stop();
    }
    activeJobs.clear();
    oneOffs = [];

    for (const reminder of reminders) {
      if (reminder.kind === "cron") {
        try {
          const job = CronJob.from({
            cronTime: reminder.cron,
            onTick: () => fireReminder(reminder, brain, bot),
            start: true,
          });
          activeJobs.set(reminder.file, job);
          console.log(
            `[Scheduler] Scheduled "${reminder.name}" for ${reminder.userName} (${reminder.cron})`,
          );
        } catch (err) {
          console.error(`[Scheduler] Invalid cron "${reminder.cron}" in ${reminder.file}:`, err);
        }
      } else {
        oneOffs.push(reminder);
      }
    }

    const total = activeJobs.size + oneOffs.length;
    console.log(`[Scheduler] ${activeJobs.size} recurring, ${oneOffs.length} one-off (${total} total)`);
  }

  // Initial sync
  syncReminders(true);

  // Check every 30 seconds
  setInterval(() => {
    syncReminders();
  }, 30_000);
}
