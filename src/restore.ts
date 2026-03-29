import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import { decrypt } from "./vault/crypto.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectName = process.env.STEVE_PROJECT || "steve";
const cliCommand = process.env.STEVE_CLI_COMMAND || "steve";

function getVolumeName(name: "data" | "vault") {
  return `${projectName}_steve-${name}`;
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    p.log.error(`Usage: ${cliCommand} restore <backup-file>`);
    process.exit(1);
  }

  p.intro("Steve — Restore");

  const pw = process.env.STEVE_BACKUP_PASSWORD || await p.password({ message: "Backup password" });
  if (p.isCancel(pw)) { p.cancel("Cancelled."); process.exit(0); }

  const s = p.spinner();
  s.start("Restoring backup");

  try {
    // Read and decrypt
    const encrypted = readFileSync(file);
    const json = decrypt(encrypted, pw);
    const bundle = JSON.parse(json);

    if (bundle.version !== 1) {
      throw new Error(`Unsupported backup version: ${bundle.version}`);
    }

    const dataTar = Buffer.from(bundle.data, "base64");
    const vaultTar = Buffer.from(bundle.vault, "base64");

    // Ensure volumes exist
    execSync(`docker volume create ${getVolumeName("data")}`, { cwd: projectRoot, stdio: "ignore" });
    execSync(`docker volume create ${getVolumeName("vault")}`, { cwd: projectRoot, stdio: "ignore" });

    // Restore data volume
    execSync(
      `docker run --rm -i -v ${getVolumeName("data")}:/data alpine tar xzf - -C /data`,
      { cwd: projectRoot, input: dataTar, stdio: ["pipe", "ignore", "ignore"] },
    );

    // Restore vault volume
    execSync(
      `docker run --rm -i -v ${getVolumeName("vault")}:/vault alpine tar xzf - -C /vault`,
      { cwd: projectRoot, input: vaultTar, stdio: ["pipe", "ignore", "ignore"] },
    );

    s.stop("Restored");
    p.log.success(`Backup from ${bundle.date}`);
    p.outro(`Run '${cliCommand} up' to start Steve`);
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
