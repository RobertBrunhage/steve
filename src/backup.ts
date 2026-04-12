import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
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

async function main() {
  p.intro(`${APP_NAME} — Backup`);

  const pw = readEnv("KELLIX_BACKUP_PASSWORD", "STEVE_BACKUP_PASSWORD") || await p.password({ message: "Backup password" });
  if (p.isCancel(pw)) { p.cancel("Cancelled."); process.exit(0); }

  const s = p.spinner();
  s.start("Creating backup");

  try {
    // Dump data volume to tar
    const dataTar = execSync(
      `docker run --rm -v ${getVolumeName("data")}:/data alpine tar czf - -C /data .`,
      { cwd: projectRoot, maxBuffer: 100 * 1024 * 1024 },
    );

    // Dump vault volume to tar
    const vaultTar = execSync(
      `docker run --rm -v ${getVolumeName("vault")}:/vault alpine tar czf - -C /vault .`,
      { cwd: projectRoot, maxBuffer: 10 * 1024 * 1024 },
    );

    // Bundle: JSON with base64-encoded tars
    const bundle = JSON.stringify({
      version: 1,
      date: new Date().toISOString(),
      data: dataTar.toString("base64"),
      vault: vaultTar.toString("base64"),
    });

    // Encrypt with password
    const encrypted = encrypt(bundle, pw);

    const filenameArg = process.argv[2];
    const date = new Date().toISOString().split("T")[0];
    const filename = filenameArg || `${APP_SLUG}-backup-${date}.enc`;
    writeFileSync(filename, encrypted);
    const displayPath = getBackupDisplayPath(filename);

    s.stop(`Backup saved to ${displayPath}`);
    p.outro(`${(encrypted.length / 1024 / 1024).toFixed(1)} MB`);
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
