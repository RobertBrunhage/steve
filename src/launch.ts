import { spawn, execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
      - type: volume
        source: steve-data
        target: /data
        volume:
          subpath: users/${name}
      - type: volume
        source: steve-data
        target: /data/skills
        volume:
          subpath: skills
      - type: volume
        source: steve-data
        target: /data/shared
        volume:
          subpath: shared
      - opencode-auth:/root/.local/share/opencode
    networks: [steve-net]`;
  }).join("\n");

  const composed = base.replace(
    /\nvolumes:/,
    `${userServices}\n\nvolumes:`,
  );

  writeFileSync(join(projectRoot, "docker-compose.dev.yml"), composed, "utf-8");
}

async function main() {
  p.intro("Steve");

  process.env.STEVE_HOST_IP = getHostIp();
  process.env.STEVE_OPENCODE_IMAGE = "steve-opencode";

  // Build
  const s = p.spinner();
  s.start("Building");
  generateCompose([]);
  try {
    exec("docker compose -f docker-compose.dev.yml build steve --quiet", true);
    // Build custom OpenCode image for user agents
    exec("docker build -t steve-opencode -f opencode.Dockerfile . -q", true);
  } catch {
    s.stop("Build failed");
    process.exit(1);
  }
  s.stop("Built");

  // Start Steve only — user agents started from dashboard
  p.log.success("Starting Steve...");

  const steve = spawn("docker", ["compose", "-f", "docker-compose.dev.yml", "up", "--no-log-prefix", "steve"], {
    stdio: "inherit",
    cwd: projectRoot,
    env: process.env,
  });


  steve.on("exit", () => {
    // Stop all opencode containers
    try {
      const containers = execSync("docker ps --filter name=opencode- --format {{.Names}}", { encoding: "utf-8" }).trim();
      if (containers) {
        execSync(`docker stop ${containers.split("\n").join(" ")}`, { stdio: "inherit", timeout: 15000 });
        execSync(`docker rm ${containers.split("\n").join(" ")}`, { stdio: "ignore" });
      }
    } catch {}
    try {
      execSync("docker compose -f docker-compose.dev.yml down", { cwd: projectRoot, stdio: "ignore" });
    } catch {}
    process.exit(0);
  });

  process.on("SIGINT", () => steve.kill());
  process.on("SIGTERM", () => steve.kill());
}

main().catch((err) => {
  p.log.error(String(err));
  process.exit(1);
});
