import { writeFileSync } from "node:fs";
import { join } from "node:path";

export type UsersMap = Record<string, string>;

export function toUserSlug(userName: string): string {
  return userName.trim().toLowerCase();
}

export function sameUser(userA: string, userB: string): boolean {
  return toUserSlug(userA) === toUserSlug(userB);
}

export function uniqueUserSlugs(users: UsersMap): string[] {
  return [...new Set(Object.values(users).map(toUserSlug))];
}

export function findUserId(users: UsersMap, userName: string): string | null {
  for (const [id, name] of Object.entries(users)) {
    if (sameUser(name, userName)) return id;
  }
  return null;
}

export function writeUserManifest(dataDir: string, users: UsersMap): void {
  writeFileSync(
    join(dataDir, "users.json"),
    JSON.stringify({ users: uniqueUserSlugs(users) }, null, 2),
    "utf-8",
  );
}
