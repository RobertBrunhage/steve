import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import { APP_NAME, APP_SLUG, readEnv } from "./brand.js";
import { encrypt } from "./vault/crypto.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectName = readEnv("KELLIX_PROJECT", "STEVE_PROJECT") || APP_SLUG;

function getBackupDisplayPath(outputName: string): string {
  const explicitPath = readEnv("KELLIX_BACKUP_OUTPUT_PATH", "STEVE_BACKUP_OUTPUT_PATH");
  if (explicitPath) {
    return explicitPath;
  }
  const explicitDir = readEnv("KELLIX_BACKUP_OUTPUT_DIR", "STEVE_BACKUP_OUTPUT_DIR");
  if (explicitDir) {
    return resolve(explicitDir, outputName);
  }
  return resolve(outputName);
}

function getVolumeName(name: "data" | "vault") {
  return `${projectName}_${APP_SLUG}-${name}`;
}

function dumpVolume(volume: string, target: string, mount: string) {
  const fd = openSync(target, "w");
  try {
    const result = spawnSync("docker", ["run", "--rm", "-v", `${volume}:${mount}`, "alpine", "tar", "czf", "-", "-C", mount, "."], {
      cwd: projectRoot,
      stdio: ["ignore", fd, "pipe"],
      encoding: "utf-8",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || `Failed to dump ${volume}`);
  } finally {
    closeSync(fd);
  }
}

async function main() {
  p.intro(`${APP_NAME} — Backup`);

  const pw = readEnv("KELLIX_BACKUP_PASSWORD", "STEVE_BACKUP_PASSWORD") || await p.password({ message: "Backup password" });
  if (p.isCancel(pw)) { p.cancel("Cancelled."); process.exit(0); }

  const s = p.spinner();
  s.start("Creating backup");

  try {
    const tempDir = mkdtempSync(join(tmpdir(), `${APP_SLUG}-backup-`));
    const date = new Date().toISOString();
    const bundlePath = join(tempDir, "bundle.tgz");
    try {
      dumpVolume(getVolumeName("data"), join(tempDir, "data.tgz"), "/data");
      dumpVolume(getVolumeName("vault"), join(tempDir, "vault.tgz"), "/vault");
      writeFileSync(join(tempDir, "manifest.json"), `${JSON.stringify({ version: 2, date })}\n`, "utf-8");
      execFileSync("tar", ["czf", bundlePath, "-C", tempDir, "manifest.json", "data.tgz", "vault.tgz"], { cwd: projectRoot, stdio: "ignore" });

      // Encrypt the archive bytes directly. This avoids execSync stdout buffers
      // and avoids base64-in-JSON expansion for larger data volumes.
      const encrypted = encrypt(readFileSync(bundlePath), pw);

      const filenameArg = process.argv[2];
      const filenameDate = date.split("T")[0];
      const filename = filenameArg || `${APP_SLUG}-backup-${filenameDate}.enc`;
      writeFileSync(filename, encrypted);
      const displayPath = getBackupDisplayPath(filename);

      s.stop(`Backup saved to ${displayPath}`);
      p.outro(`${(encrypted.length / 1024 / 1024).toFixed(1)} MB`);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  } catch (err) {
    s.stop("Backup failed");
    p.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main().catch((err) => {
  p.log.error(String(err));
  process.exit(1);
});
