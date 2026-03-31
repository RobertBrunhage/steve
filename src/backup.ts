import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import { encrypt } from "./vault/crypto.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectName = process.env.STEVE_PROJECT || "steve";

function getBackupDisplayPath(outputName: string): string {
  if (process.env.STEVE_BACKUP_OUTPUT_PATH) {
    return process.env.STEVE_BACKUP_OUTPUT_PATH;
  }
  if (process.env.STEVE_BACKUP_OUTPUT_DIR) {
    return resolve(process.env.STEVE_BACKUP_OUTPUT_DIR, outputName);
  }
  return resolve(outputName);
}

function getVolumeName(name: "data" | "vault") {
  return `${projectName}_steve-${name}`;
}

async function main() {
  p.intro("Steve — Backup");

  const pw = process.env.STEVE_BACKUP_PASSWORD || await p.password({ message: "Backup password" });
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
    const filename = filenameArg || `steve-backup-${date}.enc`;
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
