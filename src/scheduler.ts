import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CronJob } from "cron";
import matter from "gray-matter";
import * as p from "@clack/prompts";
import type { Brain } from "./brain/index.js";
import { config } from "./config.js";

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
      } catch {
        // Skip unparseable reminder files
      }
    }
  }

  return reminders;
}

async function fireReminder(reminder: Reminder, brain: Brain) {
  p.log.step(`Reminder: "${reminder.name}" → ${reminder.userName}`);

  await brain.think(`REMINDER: ${reminder.prompt}`, reminder.userName);

  // Delete one-off reminders after firing
  if (reminder.kind === "at") {
    try {
      unlinkSync(reminder.file);
    } catch {
      // Non-critical: file may already be deleted
    }
  }
}

function checkOneOffs(reminders: OneOffReminder[], brain: Brain) {
  const now = Date.now();

  for (const reminder of reminders) {
    if (firedOneOffs.has(reminder.file)) continue;
    if (reminder.at.getTime() <= now) {
      firedOneOffs.add(reminder.file);
      fireReminder(reminder, brain);
    }
  }
}

export function startScheduler(brain: Brain) {
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
      checkOneOffs(oneOffs, brain);
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
            onTick: () => fireReminder(reminder, brain),
            start: true,
          });
          activeJobs.set(reminder.file, job);
          p.log.info(`Scheduled "${reminder.name}" for ${reminder.userName}`);
        } catch {
          p.log.warn(`Invalid cron "${reminder.cron}" in ${reminder.file}`);
        }
      } else {
        oneOffs.push(reminder);
      }
    }

    const total = activeJobs.size + oneOffs.length;
    if (total > 0) {
      p.log.info(`${total} reminder${total === 1 ? "" : "s"} loaded`);
    }
  }

  // Initial sync
  syncReminders(true);

  // Check every 30 seconds
  setInterval(() => {
    syncReminders();
  }, 30_000);
}
