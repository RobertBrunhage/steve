import * as p from "@clack/prompts";
import { APP_NAME } from "./brand.js";
import { config, getUserSkillsDir } from "./config.js";
import { syncBundledSkillsForUser, validateSkillDirectories } from "./skills.js";
import { readUsersFromVault, uniqueUserSlugs } from "./users.js";
import { Vault, readKeyfile } from "./vault/index.js";

function usage(): never {
  p.log.error("Usage: node dist/update-skills.js [--force]");
  process.exit(1);
}

function parseArgs(argv: string[]) {
  let force = false;

  for (const arg of argv) {
    if (arg === "--force") {
      force = true;
      continue;
    }
    usage();
  }

  return { force };
}

async function main() {
  const { force } = parseArgs(process.argv.slice(2));
  p.intro(`${APP_NAME} - Update Skills${force ? " (force)" : ""}`);

  const keyfile = readKeyfile(config.vaultDir);
  if (!keyfile) {
    p.log.error(`${APP_NAME} is not set up yet. Start it and finish setup first.`);
    process.exit(1);
  }

  const vault = new Vault(config.vaultDir, keyfile);
  const users = readUsersFromVault(vault);
  const userNames = uniqueUserSlugs(users);

  if (userNames.length === 0) {
    p.log.warn("No users found. Create users in the dashboard first.");
    return;
  }

  let installed = 0;
  let updated = 0;
  let skipped = 0;

  for (const userName of userNames) {
    const result = syncBundledSkillsForUser(config.defaultSkillsDir, getUserSkillsDir(userName), { force });
    validateSkillDirectories(getUserSkillsDir(userName));

    installed += result.installed.length;
    updated += result.updated.length;
    skipped += result.skipped.length;

    const parts: string[] = [];
    if (result.installed.length > 0) parts.push(`installed ${result.installed.length}`);
    if (result.updated.length > 0) parts.push(`updated ${result.updated.length}`);
    if (result.skipped.length > 0) parts.push(`skipped ${result.skipped.length}`);
    p.log.step(`${userName}: ${parts.join(", ") || "no changes"}`);
  }

  p.outro(`Done. Installed ${installed}, updated ${updated}, skipped ${skipped}.`);
}

main().catch((error) => {
  p.log.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
