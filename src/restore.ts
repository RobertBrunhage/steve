import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import { APP_NAME, APP_SLUG, readEnv } from "./brand.js";
import { decrypt, decryptBuffer } from "./vault/crypto.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectName = readEnv("KELLIX_PROJECT", "STEVE_PROJECT") || APP_SLUG;
const cliCommand = readEnv("KELLIX_CLI_COMMAND", "STEVE_CLI_COMMAND") || APP_SLUG;

function getVolumeName(name: "data" | "vault") {
  return `${projectName}_${APP_SLUG}-${name}`;
}

function restoreTarToVolume(tar: Buffer, volume: string, mount: string) {
  execSync(
    `docker run --rm -i -v ${volume}:${mount} alpine tar xzf - -C ${mount}`,
    { cwd: projectRoot, input: tar, stdio: ["pipe", "ignore", "ignore"] },
  );
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    p.log.error(`Usage: ${cliCommand} restore <backup-file>`);
    process.exit(1);
  }

  p.intro(`${APP_NAME} — Restore`);

  const pw = readEnv("KELLIX_BACKUP_PASSWORD", "STEVE_BACKUP_PASSWORD") || await p.password({ message: "Backup password" });
  if (p.isCancel(pw)) { p.cancel("Cancelled."); process.exit(0); }

  const s = p.spinner();
  s.start("Restoring backup");

  try {
    const encrypted = readFileSync(file);
    const decrypted = decryptBuffer(encrypted, pw);

    let date = "unknown";
    let dataTar: Buffer;
    let vaultTar: Buffer;

    if (decrypted.subarray(0, 1).toString("utf-8") === "{") {
      const bundle = JSON.parse(decrypt(encrypted, pw));
      if (bundle.version !== 1) {
        throw new Error(`Unsupported backup version: ${bundle.version}`);
      }
      date = bundle.date;
      dataTar = Buffer.from(bundle.data, "base64");
      vaultTar = Buffer.from(bundle.vault, "base64");
    } else {
      const tempDir = mkdtempSync(join(tmpdir(), `${APP_SLUG}-restore-`));
      try {
        const bundlePath = join(tempDir, "bundle.tgz");
        writeFileSync(bundlePath, decrypted);
        execFileSync("tar", ["xzf", bundlePath, "-C", tempDir], { cwd: projectRoot, stdio: "ignore" });
        const manifest = JSON.parse(readFileSync(join(tempDir, "manifest.json"), "utf-8"));
        if (manifest.version !== 2) {
          throw new Error(`Unsupported backup version: ${manifest.version}`);
        }
        date = manifest.date;
        dataTar = readFileSync(join(tempDir, "data.tgz"));
        vaultTar = readFileSync(join(tempDir, "vault.tgz"));
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }

    // Ensure volumes exist
    execSync(`docker volume create ${getVolumeName("data")}`, { cwd: projectRoot, stdio: "ignore" });
    execSync(`docker volume create ${getVolumeName("vault")}`, { cwd: projectRoot, stdio: "ignore" });

    restoreTarToVolume(dataTar, getVolumeName("data"), "/data");
    restoreTarToVolume(vaultTar, getVolumeName("vault"), "/vault");

    s.stop("Restored");
    p.log.success(`Backup from ${date}`);
    p.outro(`Run '${cliCommand} up' to start ${APP_NAME}`);
  } catch (err) {
    s.stop("Restore failed");
    p.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main().catch((err) => {
  p.log.error(String(err));
  process.exit(1);
});
