import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import * as p from "@clack/prompts";
import { config } from "./config.js";

async function checkDocker(): Promise<boolean> {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function checkOpenCode(): Promise<boolean> {
  // In Docker, we'd need to check per-user containers — just check if any respond
  try {
    const res = await fetch("http://localhost:3456", { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

function checkPort(port: number): boolean {
  try {
    execSync(`lsof -i :${port}`, { stdio: "ignore" });
    return true; // something is listening
  } catch {
    return false;
  }
}

async function main() {
  p.intro("Steve Doctor");

  const checks: { name: string; ok: boolean; detail?: string }[] = [];

  // Docker
  const dockerOk = await checkDocker();
  checks.push({ name: "Docker", ok: dockerOk, detail: dockerOk ? "running" : "not running or not installed" });

  // Vault file
  const vaultOk = existsSync(config.vaultPath);
  checks.push({ name: "Vault file", ok: vaultOk, detail: vaultOk ? config.vaultPath : "not found" });

  // Users directory
  const usersOk = existsSync(config.usersDir);
  checks.push({ name: "Users directory", ok: usersOk, detail: usersOk ? config.usersDir : "not found — run pnpm launch first" });

  // OpenCode
  const ocOk = await checkOpenCode();
  checks.push({ name: "OpenCode", ok: ocOk, detail: ocOk ? "reachable" : "not reachable" });

  // Telegram — can't validate without vault password, just check if vault exists
  checks.push({ name: "Telegram bot", ok: vaultOk, detail: vaultOk ? "credentials in vault" : "vault not found" });

  // Ports
  const webPortBusy = checkPort(config.webPort);
  checks.push({ name: `Port ${config.webPort} (web)`, ok: true, detail: webPortBusy ? "in use" : "available" });

  const mcpPortBusy = checkPort(config.mcpPort);
  checks.push({ name: `Port ${config.mcpPort} (MCP)`, ok: true, detail: mcpPortBusy ? "in use" : "available" });

  // Display results
  for (const check of checks) {
    if (check.ok) {
      p.log.success(`${check.name}: ${check.detail || "ok"}`);
    } else {
      p.log.error(`${check.name}: ${check.detail || "failed"}`);
    }
  }

  const allOk = checks.every((c) => c.ok);
  p.outro(allOk ? "All checks passed" : "Some checks failed");
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  p.log.error(String(err));
  process.exit(1);
});
