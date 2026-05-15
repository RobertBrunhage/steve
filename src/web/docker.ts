import { spawnSync } from "node:child_process";
import { getUserAgentComposePath } from "../agents.js";
import { readEnv } from "../brand.js";
import { toUserSlug } from "../users.js";

function slug(value: string): string {
  return toUserSlug(value);
}

function getServiceName(userName: string, agentId: string): string {
  return `opencode-${slug(userName)}-${slug(agentId)}`;
}

function getContainerName(composeProject: string, userName: string, agentId: string): string {
  return `${composeProject}-opencode-${slug(userName)}-${slug(agentId)}`;
}

function runDocker(args: string[], opts: { timeout?: number; input?: Buffer; encoding?: BufferEncoding } = {}) {
  return spawnSync("docker", args, {
    timeout: opts.timeout,
    input: opts.input,
    encoding: opts.encoding,
  });
}

function ensureDockerSuccess(result: ReturnType<typeof runDocker>, fallback = "Docker command failed") {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
    throw new Error(stderr || stdout || fallback);
  }
}

function runUserAgentCompose(composeProject: string, args: string[]) {
  return runDocker(["compose", "-p", composeProject, "-f", getUserAgentComposePath(), ...args], {
    timeout: 30000,
    encoding: "utf-8",
  });
}

export function getComposeProject(): string {
  return readEnv("KELLIX_PROJECT", "STEVE_PROJECT") || "kellix";
}

export function startUserAgent(composeProject: string, userName: string, agentId: string): void {
  const result = runUserAgentCompose(composeProject, ["up", "-d", getServiceName(userName, agentId)]);
  ensureDockerSuccess(result, "Failed to start user agent");
}

export function stopUserAgent(composeProject: string, userName: string, agentId: string): void {
  const result = runDocker(["stop", getContainerName(composeProject, userName, agentId)], { timeout: 15000, encoding: "utf-8" });
  ensureDockerSuccess(result, "Failed to stop user agent");
}

export function removeUserAgent(composeProject: string, userName: string, agentId: string): void {
  const result = runDocker(["rm", "-f", getContainerName(composeProject, userName, agentId)], { timeout: 15000, encoding: "utf-8" });
  ensureDockerSuccess(result, "Failed to remove user agent");
}

export function restartUserAgent(composeProject: string, userName: string, agentId: string): void {
  const result = runUserAgentCompose(composeProject, ["restart", getServiceName(userName, agentId)]);
  ensureDockerSuccess(result, "Failed to restart user agent");
}

export function updateUserAgentImage(composeProject: string, userName: string, agentId: string): void {
  const result = runUserAgentCompose(composeProject, ["pull", getServiceName(userName, agentId)]);
  ensureDockerSuccess(result, "Failed to pull OpenCode image");

  const recreate = runUserAgentCompose(composeProject, ["up", "-d", "--force-recreate", "--no-deps", getServiceName(userName, agentId)]);
  ensureDockerSuccess(recreate, "Failed to recreate user agent");
}

export function reconcileUserAgents(composeProject: string): void {
  const result = runUserAgentCompose(composeProject, ["up", "-d"]);
  ensureDockerSuccess(result, "Failed to reconcile user agents");
}

export function getUserAgentLogs(composeProject: string, userName: string, agentId: string): string {
  const result = runDocker(["logs", getContainerName(composeProject, userName, agentId), "--tail", "100"], { timeout: 5000, encoding: "utf-8" });
  if (result.error) throw result.error;
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}
