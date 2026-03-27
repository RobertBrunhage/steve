import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface StartUserAgentOptions {
  composeProject: string;
  dataDir: string;
  image: string;
  name: string;
  port: number;
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

export function getComposeProject(): string {
  const result = runDocker(["inspect", "steve", "--format", "{{index .Config.Labels \"com.docker.compose.project\"}}"], {
    timeout: 5000,
    encoding: "utf-8",
  });
  if (result.status === 0 && typeof result.stdout === "string") {
    return result.stdout.trim() || "steve";
  }
  return "steve";
}

export function startExistingUserAgent(name: string): boolean {
  const result = runDocker(["start", `opencode-${name}`], { timeout: 10000, encoding: "utf-8" });
  if (result.status === 0) return true;
  return false;
}

export function startUserAgent(opts: StartUserAgentOptions): void {
  const userDir = join(opts.dataDir, "users", opts.name);
  for (const sub of ["memory", "memory/daily", "memory/nutrition", "memory/training", "memory/body-measurements", ".opencode-data"]) {
    mkdirSync(join(userDir, sub), { recursive: true });
  }

  const composeContent = [
    "services:",
    `  opencode-${opts.name}:`,
    `    image: ${opts.image}`,
    `    container_name: opencode-${opts.name}`,
    "    restart: unless-stopped",
    '    command: ["serve", "--port", "3456", "--hostname", "0.0.0.0"]',
    "    working_dir: /data",
    "    ports:",
    `      - "${opts.port}:3456"`,
    "    volumes:",
    "      - type: volume",
    `        source: ${opts.composeProject}_steve-data`,
    "        target: /data",
    "        volume:",
    `          subpath: users/${opts.name}`,
    "      - type: volume",
    `        source: ${opts.composeProject}_steve-data`,
    "        target: /data/skills",
    "        volume:",
    "          subpath: skills",
    "      - type: volume",
    `        source: ${opts.composeProject}_steve-data`,
    "        target: /data/shared",
    "        volume:",
    "          subpath: shared",
    "      - type: volume",
    `        source: ${opts.composeProject}_steve-data`,
    "        target: /root/.local/share/opencode",
    "        volume:",
    `          subpath: users/${opts.name}/.opencode-data`,
    `    networks: [${opts.composeProject}_steve-net]`,
    "",
    "volumes:",
    `  ${opts.composeProject}_steve-data:`,
    "    external: true",
    "",
    "networks:",
    `  ${opts.composeProject}_steve-net:`,
    "    external: true",
  ].join("\n");

  const tempDir = mkdtempSync(join(tmpdir(), "steve-opencode-"));
  const composeFile = join(tempDir, "compose.yml");

  try {
    writeFileSync(composeFile, composeContent, "utf-8");
    const result = runDocker(["compose", "-p", opts.composeProject, "-f", composeFile, "up", "-d"], {
      timeout: 30000,
      encoding: "utf-8",
    });
    ensureDockerSuccess(result, "Failed to start user agent");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export function stopUserAgent(name: string): void {
  const result = runDocker(["stop", `opencode-${name}`], { timeout: 15000, encoding: "utf-8" });
  ensureDockerSuccess(result, "Failed to stop user agent");
}

export function restartUserAgent(name: string): void {
  const result = runDocker(["restart", `opencode-${name}`], { timeout: 15000, encoding: "utf-8" });
  ensureDockerSuccess(result, "Failed to restart user agent");
}

export function getUserAgentLogs(name: string): string {
  const result = runDocker(["logs", `opencode-${name}`, "--tail", "100"], { timeout: 5000, encoding: "utf-8" });
  if (result.error) throw result.error;
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}
