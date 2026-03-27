import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CronJob } from "cron";
import * as p from "@clack/prompts";
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
}

interface UserJobs {
  userName: string;
  jobs: Job[];
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

/** Load jobs across all users */
function loadAllJobs(): UserJobs[] {
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
function loadHeartbeatUsers(): string[] {
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

async function fireJob(userName: string, job: Job, brain: Brain) {
  p.log.step(`Job: "${job.name}" → ${userName}`);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await brain.thinkIsolated(`REMINDER: ${job.prompt}`, userName);
      break;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        const delay = 1000 * Math.pow(2, attempt - 1);
        p.log.warn(`Job "${job.name}" failed (attempt ${attempt}), retrying in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      } else {
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
  try {
    await brain.thinkIsolated("HEARTBEAT: Check your HEARTBEAT.md checklist. Only message the user if something needs attention.", userName);
  } catch {
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

    const fingerprint = allUserJobs
      .flatMap(({ userName, jobs }) => jobs.map((j) => `${userName}:${j.id}:${j.cron || j.at}`))
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
    const heartbeatUsers = loadHeartbeatUsers();
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

    const totalJobs = allUserJobs.reduce((n, u) => n + u.jobs.length, 0);
    const total = activeJobs.size + allUserJobs.reduce((n, u) => n + u.jobs.filter((j) => j.at).length, 0);
    setReminderCount(total);
    if (totalJobs > 0) {
      p.log.info(`${totalJobs} job${totalJobs === 1 ? "" : "s"} loaded`);
    }
  }

  sync(true);
  setInterval(() => sync(), 30_000);
}
