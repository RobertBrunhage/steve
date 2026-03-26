import { spawn, execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import * as p from "@clack/prompts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function getHostIp(): string {
  try {
    for (const iface of ["en0", "en1", "en2", "en3", "en4", "en5"]) {
      try {
        const ip = execSync(`ipconfig getifaddr ${iface} 2>/dev/null`, { encoding: "utf-8" }).trim();
        if (ip) return ip;
      } catch {}
    }
  } catch {}
  try {
    const ip = execSync("hostname -I 2>/dev/null", { encoding: "utf-8" }).trim().split(" ")[0];
    if (ip) return ip;
  } catch {}
  return "localhost";
}

function exec(cmd: string, quiet = false) {
  execSync(cmd, { stdio: quiet ? "ignore" : "inherit", cwd: projectRoot });
}

function generateCompose(userNames: string[]) {
  const basePath = join(projectRoot, "docker-compose.base.yml");
  if (!existsSync(basePath)) return;

  const base = readFileSync(basePath, "utf-8");

  const userServices = userNames.map((name, i) => {
    const hostPort = 3457 + i;
    return `
  opencode-${name}:
    build:
      context: .
      dockerfile: opencode.Dockerfile
    container_name: opencode-${name}
    restart: unless-stopped
    command: ["serve", "--port", "3456", "--hostname", "0.0.0.0"]
    working_dir: /data
    ports:
      - "${hostPort}:3456"
    volumes:
      - \${STEVE_DATA:-~/.steve}/users/${name}:/data
      - \${STEVE_DATA:-~/.steve}/skills:/data/skills
      - \${STEVE_DATA:-~/.steve}/shared:/data/shared
      - opencode-auth:/root/.local/share/opencode
    networks: [steve-net]`;
  }).join("\n");

  const composed = base.replace(
    /\nvolumes:/,
    `${userServices}\n\nvolumes:`,
  );

  writeFileSync(join(projectRoot, "docker-compose.yml"), composed, "utf-8");

  // Write port mapping so the web UI can link to the right OpenCode instance
  const steveDir = process.env.STEVE_DIR || join(homedir(), ".steve");
  const portMap: Record<string, number> = {};
  userNames.forEach((name, i) => { portMap[name] = 3457 + i; });
  writeFileSync(join(steveDir, "opencode-ports.json"), JSON.stringify(portMap, null, 2), "utf-8");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForContainer(container: string): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    try {
      execSync(
        `docker compose exec ${container} wget -q -O /dev/null http://127.0.0.1:3456`,
        { cwd: projectRoot, stdio: "ignore" },
      );
      return true;
    } catch {
      await sleep(1000);
    }
  }
  return false;
}

function needsAuth(container: string): boolean {
  try {
    const out = execSync(`docker compose exec ${container} opencode auth list 2>&1`, {
      cwd: projectRoot,
      encoding: "utf-8",
    });
    return out.includes("0 credentials");
  } catch {
    return true;
  }
}

function readUserNames(steveDir: string): string[] {
  const manifest = join(steveDir, "users.json");
  if (!existsSync(manifest)) return [];
  try {
    const data = JSON.parse(readFileSync(manifest, "utf-8"));
    return (data.users || []).map((n: string) => n.toLowerCase());
  } catch {
    return [];
  }
}

async function startOpenCodeContainers(userNames: string[]) {
  const containers = userNames.map((n) => `opencode-${n}`);
  if (containers.length === 0) return;

  generateCompose(userNames);
  const s = p.spinner();
  s.start(`Starting ${containers.length} agent(s)`);
  exec(`docker compose up -d ${containers.join(" ")}`, true);

  for (const container of containers) {
    if (!(await waitForContainer(container))) {
      p.log.error(`${container} failed to start`);
    }
  }
  s.stop(`${containers.length} agent(s) ready`);

  // Auth check — shared volume means one check covers all
  if (needsAuth(containers[0])) {
    p.log.warn("AI provider authentication needed.");
    exec(`docker compose exec ${containers[0]} opencode auth login`);
  }

  for (const name of userNames) {
    p.log.success(`${name} ready`);
  }
}

async function main() {
  p.intro("Steve");

  const steveDir = process.env.STEVE_DIR || join(homedir(), ".steve");
  const vaultExists = existsSync(join("/var/run/docker.sock")) // dummy check
    ? false // will check vault inside container
    : existsSync(join(steveDir, "secrets.enc")); // won't exist if vault is in Docker volume

  // Password prompt
  let vaultKey = process.env.STEVE_VAULT_KEY;
  if (!vaultKey) {
    const pw = await p.password({
      message: "Password",
    });
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
  // Generate compose with current users (or base-only if none)
  let userNames = readUserNames(steveDir);
  generateCompose(userNames);
  try {
    exec("docker compose build steve --quiet", true);
  } catch {
    s.stop("Build failed");
    process.exit(1);
  }
  s.stop("Built");

  // OpenCode auth (temp container if we have users but need to check auth)
  if (userNames.length > 0) {
    await startOpenCodeContainers(userNames);
  }

  // Start Steve
  p.log.success("Starting Steve...");

  const steve = spawn("docker", ["compose", "up", "--no-log-prefix", "steve"], {
    stdio: "inherit",
    cwd: projectRoot,
    env: process.env,
  });

  // If no users yet, watch for users.json to appear (setup via web UI)
  if (userNames.length === 0) {
    (async () => {
      while (true) {
        await sleep(2000);
        const newUsers = readUserNames(steveDir);
        if (newUsers.length > 0) {
          await startOpenCodeContainers(newUsers);
          break;
        }
      }
    })();
  }

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
