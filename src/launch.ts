import { spawn, execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function getHostIp(): string {
  try {
    // macOS — check common interfaces
    for (const iface of ["en0", "en1", "en2", "en3", "en4", "en5"]) {
      try {
        const ip = execSync(`ipconfig getifaddr ${iface} 2>/dev/null`, { encoding: "utf-8" }).trim();
        if (ip) return ip;
      } catch {}
    }
  } catch {}
  try {
    // Linux
    const ip = execSync("hostname -I 2>/dev/null", { encoding: "utf-8" }).trim().split(" ")[0];
    if (ip) return ip;
  } catch {}
  return "localhost";
}

function exec(cmd: string, quiet = false) {
  execSync(cmd, { stdio: quiet ? "ignore" : "inherit", cwd: projectRoot });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForOpenCode(): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    try {
      execSync(
        "docker compose exec opencode wget -q -O /dev/null http://127.0.0.1:3456",
        { cwd: projectRoot, stdio: "ignore" },
      );
      return true;
    } catch {
      await sleep(1000);
    }
  }
  return false;
}

function needsOpenCodeAuth(): boolean {
  try {
    const out = execSync("docker compose exec opencode opencode auth list 2>&1", {
      cwd: projectRoot,
      encoding: "utf-8",
    });
    return out.includes("0 credentials");
  } catch {
    return true;
  }
}

async function main() {
  p.intro("Steve");

  // Vault password
  let vaultKey = process.env.STEVE_VAULT_KEY;
  if (!vaultKey) {
    const pw = await p.password({ message: "Vault password" });
    if (p.isCancel(pw)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    vaultKey = pw;
  }

  process.env.STEVE_VAULT_KEY = vaultKey;
  process.env.STEVE_HOST_IP = getHostIp();

  // Build
  const s = p.spinner();
  s.start("Building");
  try {
    exec("docker compose build steve --quiet", true);
  } catch {
    s.stop("Build failed");
    process.exit(1);
  }
  s.stop("Built");

  // Start OpenCode
  s.start("Starting OpenCode");
  exec("docker compose up -d opencode", true);

  if (!(await waitForOpenCode())) {
    s.stop("OpenCode failed to start");
    p.log.error("Check logs: docker compose logs opencode");
    process.exit(1);
  }
  s.stop("OpenCode ready");

  // Auth check
  if (needsOpenCodeAuth()) {
    p.log.warn("OpenCode needs authentication.");
    exec("docker compose exec opencode opencode auth login");
  }

  // Start Steve (attached — Ctrl+C stops it)
  p.log.success("Starting Steve...");

  const steve = spawn("docker", ["compose", "up", "--no-log-prefix", "steve"], {
    stdio: "inherit",
    cwd: projectRoot,
    env: process.env,
  });

  const shutdown = () => {
    steve.kill();
    try {
      execSync("docker compose down", { cwd: projectRoot, stdio: "inherit" });
    } catch {}
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  steve.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  p.log.error(String(err));
  process.exit(1);
});
