import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CronJob } from "cron";
import * as p from "@clack/prompts";
import { appendUserActivity } from "./activity.js";
import { APP_SLUG } from "./brand.js";
import type { Brain } from "./brain/index.js";
import { config, getSystemTimezone, getUserAgentDir } from "./config.js";
import { setReminderCount } from "./health.js";
import { toUserSlug } from "./users.js";
import { fingerprintWorkflowTriggers, loadAllWorkflowTriggers, type WorkflowTriggerEntry } from "./workflows/triggers.js";
import type { WorkflowRunner } from "./workflows/runner.js";

export interface Job {
  id: string;
  agentId?: string;
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

interface UserAgentJobs {
  userName: string;
  agentId: string;
  jobs: Job[];
}

export interface ScheduledEntry {
  kind: "job" | "heartbeat" | "workflow";
  userName: string;
  agentId?: string;
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
const DAILY_COMPACTION_CRON = "0 23 * * *";

function agentOrDefault(agentId?: string): string {
  return agentId ? toUserSlug(agentId) : APP_SLUG;
}

/** Path to a specific (user, agent)'s jobs.json */
export function getAgentJobsPath(userName: string, agentId: string): string {
  return join(getUserAgentDir(userName, agentId), "jobs", "jobs.json");
}

/** Legacy path (user-root jobs.json). Used only for one-shot migration. */
function getLegacyUserJobsPath(userName: string): string {
  return join(config.usersDir, toUserSlug(userName), "jobs.json");
}

function readJobsFile(path: string): Job[] {
  try {
    if (!existsSync(path)) return [];
    const data = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(data?.jobs) ? data.jobs as Job[] : [];
  } catch {
    return [];
  }
}

function writeJobsFile(path: string, jobs: Job[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ jobs }, null, 2)}\n`, "utf-8");
}

/** List agent dirs for a user that exist on disk. */
function listAgentDirsForUser(userName: string): string[] {
  const user = toUserSlug(userName);
  const dir = join(config.usersDir, user, "agents");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
}

/** Load jobs for a specific (user, agent). */
export function loadUserAgentJobs(userName: string, agentId: string): Job[] {
  return readJobsFile(getAgentJobsPath(userName, agentOrDefault(agentId)));
}

/** Save jobs for a specific (user, agent). */
export function saveUserAgentJobs(userName: string, agentId: string, jobs: Job[]): void {
  writeJobsFile(getAgentJobsPath(userName, agentOrDefault(agentId)), jobs);
}

/** Aggregate all jobs across every agent for a user. */
export function loadUserJobs(userName: string): Job[] {
  const user = toUserSlug(userName);
  const out: Job[] = [];
  for (const agentId of listAgentDirsForUser(user)) {
    const jobs = readJobsFile(getAgentJobsPath(user, agentId));
    for (const job of jobs) {
      out.push({ ...job, agentId: job.agentId || agentId });
    }
  }
  return out;
}

/** Replace a user's full jobs set; splits by agentId across per-agent files. */
export function saveUserJobs(userName: string, jobs: Job[]): void {
  const user = toUserSlug(userName);
  const groups: Record<string, Job[]> = {};
  for (const job of jobs) {
    const aid = agentOrDefault(job.agentId);
    (groups[aid] = groups[aid] || []).push(job);
  }

  // Write the agents that have jobs.
  for (const [agentId, agentJobs] of Object.entries(groups)) {
    writeJobsFile(getAgentJobsPath(user, agentId), agentJobs);
  }

  // Clear any agent dirs that previously had jobs but are now absent from the set.
  for (const agentId of listAgentDirsForUser(user)) {
    if (groups[agentId]) continue;
    const path = getAgentJobsPath(user, agentId);
    if (existsSync(path)) writeJobsFile(path, []);
  }
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
  const agentId = agentOrDefault(job.agentId);
  const path = getAgentJobsPath(user, agentId);
  const jobs = readJobsFile(path);
  const existing = jobs.find((entry) => entry.id === job.id);
  const filtered = jobs.filter((entry) => entry.id !== job.id);
  filtered.push(mergeJobMetadata(existing, { ...job, agentId }));
  writeJobsFile(path, filtered);
}

export function removeUserJob(userName: string, id: string, agentId?: string): boolean {
  const user = toUserSlug(userName);
  const targets = agentId ? [agentOrDefault(agentId)] : listAgentDirsForUser(user);
  let removed = false;
  for (const aid of targets) {
    const path = getAgentJobsPath(user, aid);
    const jobs = readJobsFile(path);
    const next = jobs.filter((entry) => entry.id !== id);
    if (next.length !== jobs.length) {
      writeJobsFile(path, next);
      removed = true;
    }
  }
  return removed;
}

export function setUserJobDisabled(userName: string, id: string, disabled: boolean, agentId?: string): boolean {
  const user = toUserSlug(userName);
  const targets = agentId ? [agentOrDefault(agentId)] : listAgentDirsForUser(user);
  let updated = false;
  for (const aid of targets) {
    const path = getAgentJobsPath(user, aid);
    const jobs = readJobsFile(path);
    let touched = false;
    const next = jobs.map((entry) => {
      if (entry.id !== id) return entry;
      touched = true;
      return { ...entry, disabled };
    });
    if (touched) {
      writeJobsFile(path, next);
      updated = true;
    }
  }
  return updated;
}

/**
 * One-shot migration of a legacy user-root jobs.json into per-agent files.
 * Idempotent: only runs when the legacy file exists.
 */
export function migrateLegacyUserJobs(userName: string): void {
  const user = toUserSlug(userName);
  const legacy = getLegacyUserJobsPath(user);
  if (!existsSync(legacy)) return;
  const jobs = readJobsFile(legacy);
  const groups: Record<string, Job[]> = {};
  for (const job of jobs) {
    const aid = agentOrDefault(job.agentId);
    (groups[aid] = groups[aid] || []).push({ ...job, agentId: aid });
  }
  for (const [agentId, group] of Object.entries(groups)) {
    const dest = getAgentJobsPath(user, agentId);
    if (existsSync(dest)) continue;
    writeJobsFile(dest, group);
  }
  try {
    writeFileSync(legacy, `${JSON.stringify({ jobs: [], migrated: new Date().toISOString() }, null, 2)}\n`, "utf-8");
  } catch {}
}

/** Load jobs across all (user, agent) pairs */
export function loadAllJobs(): UserAgentJobs[] {
  const result: UserAgentJobs[] = [];
  try {
    for (const userDirName of readdirSync(config.usersDir)) {
      if (userDirName.startsWith(".")) continue;
      for (const agentId of listAgentDirsForUser(userDirName)) {
        const jobs = readJobsFile(getAgentJobsPath(userDirName, agentId));
        if (jobs.length > 0) {
          result.push({ userName: userDirName, agentId, jobs: jobs.map((job) => ({ ...job, agentId: job.agentId || agentId })) });
        }
      }
    }
  } catch {}
  return result;
}

/** (user, agent) pairs that have a HEARTBEAT.md inside their agent folder. */
export function loadHeartbeatAgents(): Array<{ userName: string; agentId: string }> {
  const result: Array<{ userName: string; agentId: string }> = [];
  for (const userDirName of loadUserDirectories()) {
    for (const agentId of listAgentDirsForUser(userDirName)) {
      if (existsSync(join(getUserAgentDir(userDirName, agentId), "HEARTBEAT.md"))) {
        result.push({ userName: userDirName, agentId });
      }
    }
  }
  return result;
}

function loadUserDirectories(): string[] {
  const users: string[] = [];
  try {
    for (const userDirName of readdirSync(config.usersDir)) {
      if (userDirName.startsWith(".")) continue;
      users.push(userDirName);
    }
  } catch {}
  return users;
}

export function listScheduledEntries(): ScheduledEntry[] {
  const allJobs = loadAllJobs().flatMap(({ userName, agentId, jobs }) =>
    jobs.map((job) => ({ kind: "job" as const, userName, ...job, agentId: job.agentId || agentId })),
  );
  const heartbeats = loadHeartbeatAgents().map(({ userName, agentId }) => ({
    kind: "heartbeat" as const,
    userName,
    agentId,
    id: "heartbeat",
    name: "Heartbeat",
    cron: "*/30 8-21 * * *",
  }));
  const workflowTriggers: ScheduledEntry[] = loadAllWorkflowTriggers()
    .filter((t) => t.cron || t.at)
    .map((t) => ({
      kind: "workflow" as const,
      userName: t.userName,
      agentId: t.agentId,
      id: t.workflowName,
      name: `${t.workflowName} (workflow)`,
      cron: t.cron,
      at: t.at,
      timezone: t.timezone,
    }));
  return [...allJobs, ...heartbeats, ...workflowTriggers].sort((a, b) => a.userName.localeCompare(b.userName) || a.name.localeCompare(b.name));
}

export function getVisibleScheduledEntryCount(): number {
  return listScheduledEntries().length;
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

function updateJobRunState(userName: string, job: Job, patch: Partial<Job>): void {
  const user = toUserSlug(userName);
  const agentId = agentOrDefault(job.agentId);
  const path = getAgentJobsPath(user, agentId);
  const jobs = readJobsFile(path);
  const next = jobs.map((entry) => (entry.id === job.id ? { ...entry, ...patch } : entry));
  writeJobsFile(path, next);
}

async function fireJob(userName: string, job: Job, brain: Brain) {
  const agentId = agentOrDefault(job.agentId);
  p.log.step(`Job: "${job.name}" → ${userName}/${agentId}`);
  const startedAt = Date.now();
  updateJobRunState(userName, job, {
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
        agentId,
      );
      updateJobRunState(userName, job, {
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
        updateJobRunState(userName, job, {
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
    removeUserJob(userName, job.id, agentId);
  }
}

async function fireHeartbeat(userName: string, agentId: string, brain: Brain) {
  p.log.step(`Heartbeat → ${userName}/${agentId}`);
  appendUserActivity(config.dataDir, {
    timestamp: new Date().toISOString(),
    userName,
    type: "job",
    status: "info",
    summary: `Started heartbeat routine (${agentId})`,
  });
  try {
    await brain.thinkIsolated("HEARTBEAT: Check your HEARTBEAT.md checklist. Only message the user if something needs attention.", userName, agentId);
    appendUserActivity(config.dataDir, {
      timestamp: new Date().toISOString(),
      userName,
      type: "job",
      status: "ok",
      summary: `Completed heartbeat routine (${agentId})`,
    });
  } catch {
    appendUserActivity(config.dataDir, {
      timestamp: new Date().toISOString(),
      userName,
      type: "job",
      status: "error",
      summary: `Heartbeat routine failed (${agentId})`,
    });
    p.log.warn(`Heartbeat failed for ${userName}/${agentId}`);
  }
}

async function fireDailyCompaction(userName: string, agentId: string, brain: Brain) {
  p.log.step(`Daily compaction -> ${userName}/${agentId}`);
  try {
    const compacted = await brain.compactPrimarySession(userName, agentId);
    if (!compacted) {
      p.log.info(`Daily compaction skipped for ${userName}/${agentId} (no primary session yet)`);
      return;
    }
    p.log.info(`Daily compaction finished for ${userName}/${agentId}; primary session cleared`);
  } catch (error) {
    p.log.warn(`Daily compaction failed for ${userName}/${agentId}: ${error instanceof Error ? error.message : error}`);
  }
}

function checkOneOffs(allUserJobs: UserAgentJobs[], brain: Brain) {
  const now = Date.now();
  for (const { userName, agentId, jobs } of allUserJobs) {
    for (const job of jobs) {
      if (!job.at) continue;
      const key = `${userName}:${agentId}:${job.id}`;
      if (firedOneOffs.has(key)) continue;
      const at = new Date(job.at).getTime();
      if (!isNaN(at) && at <= now) {
        firedOneOffs.add(key);
        fireJob(userName, job, brain);
      }
    }
  }
}

function registerWorkflowTriggers(entries: WorkflowTriggerEntry[], engine: WorkflowRunner): void {
  for (const entry of entries) {
    if (entry.cron) {
      try {
        const cronJob = CronJob.from({
          cronTime: entry.cron,
          onTick: () => {
            engine.runByName(entry.userName, entry.agentId, entry.workflowName, { triggerKind: "cron" }).catch((err) => {
              p.log.warn(`workflow ${entry.workflowName} failed: ${err instanceof Error ? err.message : err}`);
            });
          },
          start: true,
          timeZone: entry.timezone,
        });
        activeJobs.set(`workflow:${entry.userName}:${entry.agentId}:${entry.workflowName}`, cronJob);
        p.log.info(`Scheduled workflow "${entry.workflowName}" for ${entry.userName}/${entry.agentId}`);
      } catch {
        p.log.warn(`Invalid cron "${entry.cron}" for workflow ${entry.userName}/${entry.agentId}/${entry.workflowName}`);
      }
    }
    if (entry.at) {
      const at = new Date(entry.at).getTime();
      const now = Date.now();
      if (!Number.isNaN(at) && at > now) {
        const key = `workflow-at:${entry.userName}:${entry.agentId}:${entry.workflowName}`;
        const timer = setTimeout(() => {
          engine.runByName(entry.userName, entry.agentId, entry.workflowName, { triggerKind: "at" }).catch((err) => {
            p.log.warn(`workflow ${entry.workflowName} failed: ${err instanceof Error ? err.message : err}`);
          });
        }, at - now);
        // Track via activeJobs interface: store a stub with stop()
        const stub = { stop: () => clearTimeout(timer) } as unknown as CronJob;
        activeJobs.set(key, stub);
      }
    }
  }
}

function listAllUserAgents(): Array<{ userName: string; agentId: string }> {
  const out: Array<{ userName: string; agentId: string }> = [];
  for (const userName of loadUserDirectories()) {
    for (const agentId of listAgentDirsForUser(userName)) {
      out.push({ userName, agentId });
    }
  }
  return out;
}

export function startScheduler(brain: Brain, engine?: WorkflowRunner) {
  let lastFingerprint = "";

  function sync(initial = false) {
    const allUserJobs = loadAllJobs();
    const heartbeats = loadHeartbeatAgents();
    const compactionTargets = listAllUserAgents();
    const compactionTimezone = getSystemTimezone();
    const workflowTriggers = engine ? loadAllWorkflowTriggers() : [];

    const fingerprint = allUserJobs
      .flatMap(({ userName, agentId, jobs }) => jobs.map((j) => `${userName}:${agentId}:${j.id}:${j.cron || j.at}:${j.disabled ? "disabled" : "enabled"}`))
      .concat(heartbeats.map(({ userName, agentId }) => `heartbeat:${userName}:${agentId}`))
      .concat(compactionTargets.map(({ userName, agentId }) => `compaction:${userName}:${agentId}:${compactionTimezone}`))
      .concat(fingerprintWorkflowTriggers(workflowTriggers))
      .sort()
      .join("|");

    if (fingerprint === lastFingerprint && !initial) {
      checkOneOffs(allUserJobs, brain);
      return;
    }
    lastFingerprint = fingerprint;

    for (const [, job] of activeJobs) {
      job.stop();
    }
    activeJobs.clear();

    for (const { userName, agentId, jobs } of allUserJobs) {
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
            activeJobs.set(`${userName}:${agentId}:${job.id}`, cronJob);
            p.log.info(`Scheduled "${job.name}" for ${userName}/${agentId}`);
          } catch {
            p.log.warn(`Invalid cron "${job.cron}" for ${userName}/${agentId}/${job.id}`);
          }
        }
      }
    }

    for (const { userName, agentId } of heartbeats) {
      const hbJob = CronJob.from({
        cronTime: "*/30 8-21 * * *",
        onTick: () => fireHeartbeat(userName, agentId, brain),
        start: true,
      });
      activeJobs.set(`heartbeat:${userName}:${agentId}`, hbJob);
    }
    if (heartbeats.length > 0) {
      p.log.info(`Heartbeat active for ${heartbeats.map((h) => `${h.userName}/${h.agentId}`).join(", ")}`);
    }

    for (const { userName, agentId } of compactionTargets) {
      const compactionJob = CronJob.from({
        cronTime: DAILY_COMPACTION_CRON,
        onTick: () => fireDailyCompaction(userName, agentId, brain),
        start: true,
        timeZone: compactionTimezone,
      });
      activeJobs.set(`compaction:${userName}:${agentId}`, compactionJob);
    }
    if (compactionTargets.length > 0) {
      p.log.info(`Daily compaction active for ${compactionTargets.length} agents (${compactionTimezone})`);
    }

    if (engine) {
      registerWorkflowTriggers(workflowTriggers, engine);
    }

    const totalJobs = allUserJobs.reduce((n, u) => n + u.jobs.filter((j) => !j.disabled).length, 0);
    setReminderCount(getVisibleScheduledEntryCount());
    if (totalJobs > 0) {
      p.log.info(`${totalJobs} job${totalJobs === 1 ? "" : "s"} loaded`);
    }
  }

  sync(true);
  setInterval(() => sync(), 30_000);
}
