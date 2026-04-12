import { spawnSync } from "node:child_process";
import { getUserAgentComposePath } from "../agents.js";
import { readEnv } from "../brand.js";

function getUserContainerName(composeProject: string, name: string): string {
  return `${composeProject}-opencode-${name}`;
}

function getUserServiceName(name: string): string {
  return `opencode-${name}`;
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

export function startUserAgent(composeProject: string, name: string): void {
  const result = runUserAgentCompose(composeProject, ["up", "-d", getUserServiceName(name)]);
  ensureDockerSuccess(result, "Failed to start user agent");
}

export function stopUserAgent(composeProject: string, name: string): void {
  const result = runDocker(["stop", getUserContainerName(composeProject, name)], { timeout: 15000, encoding: "utf-8" });
  ensureDockerSuccess(result, "Failed to stop user agent");
}

export function removeUserAgent(composeProject: string, name: string): void {
  const result = runDocker(["rm", "-f", getUserContainerName(composeProject, name)], { timeout: 15000, encoding: "utf-8" });
  ensureDockerSuccess(result, "Failed to remove user agent");
}

export function restartUserAgent(composeProject: string, name: string): void {
  const result = runUserAgentCompose(composeProject, ["restart", getUserServiceName(name)]);
  ensureDockerSuccess(result, "Failed to restart user agent");
}

export function reconcileUserAgents(composeProject: string): void {
  const result = runUserAgentCompose(composeProject, ["up", "-d"]);
  ensureDockerSuccess(result, "Failed to reconcile user agents");
}

export function getUserAgentLogs(composeProject: string, name: string): string {
  const result = runDocker(["logs", getUserContainerName(composeProject, name), "--tail", "100"], { timeout: 5000, encoding: "utf-8" });
  if (result.error) throw result.error;
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}
