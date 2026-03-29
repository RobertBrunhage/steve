import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CronJob } from "cron";
import * as p from "@clack/prompts";
import { appendUserActivity } from "./activity.js";
import type { Brain } from "./brain/index.js";
import { config } from "./config.js";
import { setReminderCount } from "./health.js";
import { toUserSlug } from "./users.js";

export interface Job {
  id: string;
  name: string;
  prompt: string;
  cron?: string;
  at?: string;
  timezone?: string;
  disabled?: boolean;
  lastRunAt?: string;
  lastStatus?: "ok" | "error";
  lastError?: string;
  lastDurationMs?: number;
}

interface UserJobs {
  userName: string;
  jobs: Job[];
}

export interface ScheduledEntry {
  kind: "job" | "heartbeat";
  userName: string;
  id: string;
  name: string;
  cron?: string;
  at?: string;
  timezone?: string;
  disabled?: boolean;
  lastRunAt?: string;
  lastStatus?: "ok" | "error";
  lastError?: string;
  lastDurationMs?: number;
}

const activeJobs: Map<string, CronJob> = new Map();
const firedOneOffs: Set<string> = new Set();
const MAX_RETRIES = 3;

/** Get the jobs.json path for a specific user */
export function getUserJobsPath(userName: string): string {
  return join(config.usersDir, toUserSlug(userName), "jobs.json");
}

/** Load jobs for a single user */
export function loadUserJobs(userName: string): Job[] {
  const path = getUserJobsPath(userName);
  try {
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, "utf-8"));
      return data.jobs || [];
    }
  } catch {}
  return [];
}

/** Save jobs for a single user */
export function saveUserJobs(userName: string, jobs: Job[]) {
  writeFileSync(getUserJobsPath(userName), JSON.stringify({ jobs }, null, 2), "utf-8");
}

function mergeJobMetadata(existing: Job | undefined, next: Job): Job {
  return {
    ...existing,
    ...next,
    lastRunAt: next.lastRunAt ?? existing?.lastRunAt,
    lastStatus: next.lastStatus ?? existing?.lastStatus,
    lastError: next.lastError ?? existing?.lastError,
    lastDurationMs: next.lastDurationMs ?? existing?.lastDurationMs,
  };
}

export function upsertUserJob(userName: string, job: Job): void {
  const user = toUserSlug(userName);
  const jobs = loadUserJobs(user);
  const existing = jobs.find((entry) => entry.id === job.id);
  const nextJobs = jobs.filter((entry) => entry.id !== job.id);
  nextJobs.push(mergeJobMetadata(existing, job));
  saveUserJobs(user, nextJobs);
}

export function removeUserJob(userName: string, id: string): boolean {
  const user = toUserSlug(userName);
  const jobs = loadUserJobs(user);
  const filtered = jobs.filter((entry) => entry.id !== id);
  saveUserJobs(user, filtered);
  return filtered.length < jobs.length;
}

export function setUserJobDisabled(userName: string, id: string, disabled: boolean): boolean {
  const user = toUserSlug(userName);
  const jobs = loadUserJobs(user);
  let updated = false;
  const nextJobs = jobs.map((job) => {
    if (job.id !== id) return job;
    updated = true;
    return { ...job, disabled };
  });
  if (updated) saveUserJobs(user, nextJobs);
  return updated;
}

/** Load jobs across all users */
export function loadAllJobs(): UserJobs[] {
  const result: UserJobs[] = [];
  try {
    for (const userDirName of readdirSync(config.usersDir)) {
      if (userDirName.startsWith(".")) continue;
      const jobs = loadUserJobs(userDirName);
      if (jobs.length > 0) {
        result.push({ userName: userDirName, jobs });
      }
    }
  } catch {}
  return result;
}

/** Find users who have a HEARTBEAT.md file */
export function loadHeartbeatUsers(): string[] {
  const users: string[] = [];
  try {
    for (const userDirName of readdirSync(config.usersDir)) {
      if (userDirName.startsWith(".")) continue;
      if (existsSync(join(config.usersDir, userDirName, "HEARTBEAT.md"))) {
        users.push(userDirName);
      }
    }
  } catch {}
  return users;
}

export function listScheduledEntries(): ScheduledEntry[] {
  const allJobs = loadAllJobs().flatMap(({ userName, jobs }) => jobs.map((job) => ({ kind: "job" as const, userName, ...job })));
  const heartbeats = loadHeartbeatUsers().map((userName) => ({
    kind: "heartbeat" as const,
    userName,
    id: "heartbeat",
    name: "Heartbeat",
    cron: "*/30 8-21 * * *",
  }));
  return [...allJobs, ...heartbeats].sort((a, b) => a.userName.localeCompare(b.userName) || a.name.localeCompare(b.name));
}

export function getScheduledEntryNextRunAt(entry: Pick<ScheduledEntry, "cron" | "at" | "timezone" | "disabled">): string | null {
  if (entry.disabled) return null;
  if (entry.at) {
    const at = new Date(entry.at);
    return Number.isNaN(at.getTime()) ? null : at.toISOString();
  }
  if (!entry.cron) return null;

  try {
    const cronJob = CronJob.from({
      cronTime: entry.cron,
      onTick: () => {},
      start: false,
      timeZone: entry.timezone,
    });
    const next = cronJob.nextDate();
    return next ? next.toJSDate().toISOString() : null;
  } catch {
    return null;
  }
}

function updateJobRunState(userName: string, jobId: string, patch: Partial<Job>): void {
  const user = toUserSlug(userName);
  const jobs = loadUserJobs(user);
  const nextJobs = jobs.map((job) => (job.id === jobId ? { ...job, ...patch } : job));
  saveUserJobs(user, nextJobs);
}

async function fireJob(userName: string, job: Job, brain: Brain) {
  p.log.step(`Job: "${job.name}" → ${userName}`);
  const startedAt = Date.now();
  updateJobRunState(userName, job.id, {
    lastRunAt: new Date(startedAt).toISOString(),
    lastStatus: undefined,
    lastError: undefined,
    lastDurationMs: undefined,
  });
  appendUserActivity(config.dataDir, {
    timestamp: new Date(startedAt).toISOString(),
    userName,
    type: "job",
    status: "info",
    summary: `Started job: ${job.name}`,
  });

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await brain.thinkIsolated(
        `REMINDER: This scheduled reminder is firing right now. Do not create, change, or ask follow-up questions about scheduling. Carry out the reminder immediately by sending the user the message they should receive now. Reminder instructions: ${job.prompt}`,
        userName,
      );
      updateJobRunState(userName, job.id, {
        lastRunAt: new Date(startedAt).toISOString(),
        lastStatus: "ok",
        lastError: undefined,
        lastDurationMs: Date.now() - startedAt,
      });
      appendUserActivity(config.dataDir, {
        timestamp: new Date().toISOString(),
        userName,
        type: "job",
        status: "ok",
        summary: `Completed job: ${job.name}`,
      });
      break;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = 1000 * Math.pow(2, attempt - 1);
        p.log.warn(`Job "${job.name}" failed (attempt ${attempt}), retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        const message = err instanceof Error ? err.message : String(err);
        updateJobRunState(userName, job.id, {
          lastRunAt: new Date(startedAt).toISOString(),
          lastStatus: "error",
          lastError: message,
          lastDurationMs: Date.now() - startedAt,
        });
        appendUserActivity(config.dataDir, {
          timestamp: new Date().toISOString(),
          userName,
          type: "job",
          status: "error",
          summary: `Failed job: ${job.name}`,
        });
        p.log.error(`Job "${job.name}" failed after ${MAX_RETRIES} attempts`);
      }
    }
  }

  // Delete one-off jobs after firing
  if (job.at) {
    const jobs = loadUserJobs(userName).filter((j) => j.id !== job.id);
    saveUserJobs(userName, jobs);
  }
}

async function fireHeartbeat(userName: string, brain: Brain) {
  p.log.step(`Heartbeat → ${userName}`);
  appendUserActivity(config.dataDir, {
    timestamp: new Date().toISOString(),
    userName,
    type: "job",
    status: "info",
    summary: "Started heartbeat routine",
  });
  try {
    await brain.thinkIsolated("HEARTBEAT: Check your HEARTBEAT.md checklist. Only message the user if something needs attention.", userName);
    appendUserActivity(config.dataDir, {
      timestamp: new Date().toISOString(),
      userName,
      type: "job",
      status: "ok",
      summary: "Completed heartbeat routine",
    });
  } catch {
    appendUserActivity(config.dataDir, {
      timestamp: new Date().toISOString(),
      userName,
      type: "job",
      status: "error",
      summary: "Heartbeat routine failed",
    });
    p.log.warn(`Heartbeat failed for ${userName}`);
  }
}

function checkOneOffs(allUserJobs: UserJobs[], brain: Brain) {
  const now = Date.now();
  for (const { userName, jobs } of allUserJobs) {
    for (const job of jobs) {
      if (!job.at) continue;
      const key = `${userName}:${job.id}`;
      if (firedOneOffs.has(key)) continue;
      const at = new Date(job.at).getTime();
      if (!isNaN(at) && at <= now) {
        firedOneOffs.add(key);
        fireJob(userName, job, brain);
      }
    }
  }
}

export function startScheduler(brain: Brain) {
  let lastFingerprint = "";

  function sync(initial = false) {
    const allUserJobs = loadAllJobs();
    const heartbeatUsers = loadHeartbeatUsers();

    const fingerprint = allUserJobs
      .flatMap(({ userName, jobs }) => jobs.map((j) => `${userName}:${j.id}:${j.cron || j.at}:${j.disabled ? "disabled" : "enabled"}`))
      .concat(heartbeatUsers.map((userName) => `heartbeat:${userName}`))
      .sort()
      .join("|");

    if (fingerprint === lastFingerprint && !initial) {
      checkOneOffs(allUserJobs, brain);
      return;
    }
    lastFingerprint = fingerprint;

    // Stop all existing jobs
    for (const [, job] of activeJobs) {
      job.stop();
    }
    activeJobs.clear();

    for (const { userName, jobs } of allUserJobs) {
      for (const job of jobs) {
        if (job.disabled) continue;
        if (job.cron) {
          try {
            const cronJob = CronJob.from({
              cronTime: job.cron,
              onTick: () => fireJob(userName, job, brain),
              start: true,
              timeZone: job.timezone,
            });
            activeJobs.set(`${userName}:${job.id}`, cronJob);
            p.log.info(`Scheduled "${job.name}" for ${userName}`);
          } catch {
            p.log.warn(`Invalid cron "${job.cron}" for ${userName}/${job.id}`);
          }
        }
      }
    }

    // Heartbeats
    for (const userName of heartbeatUsers) {
      const hbJob = CronJob.from({
        cronTime: "*/30 8-21 * * *",
        onTick: () => fireHeartbeat(userName, brain),
        start: true,
      });
      activeJobs.set(`heartbeat:${userName}`, hbJob);
    }
    if (heartbeatUsers.length > 0) {
      p.log.info(`Heartbeat active for ${heartbeatUsers.join(", ")}`);
    }

    const totalJobs = allUserJobs.reduce((n, u) => n + u.jobs.filter((j) => !j.disabled).length, 0);
    const total = activeJobs.size + allUserJobs.reduce((n, u) => n + u.jobs.filter((j) => j.at && !j.disabled).length, 0);
    setReminderCount(total);
    if (totalJobs > 0) {
      p.log.info(`${totalJobs} job${totalJobs === 1 ? "" : "s"} loaded`);
    }
  }

  sync(true);
  setInterval(() => sync(), 30_000);
}
