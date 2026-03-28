import { writeFileSync } from "node:fs";
import { join } from "node:path";

export interface TelegramChannelLink {
  chat_id: string;
}

export interface UserChannels {
  telegram?: TelegramChannelLink;
}

export interface SteveUser {
  name: string;
  channels: UserChannels;
}

export type UsersMap = Record<string, SteveUser>;

export function toUserSlug(userName: string): string {
  return userName.trim().toLowerCase();
}

export function sameUser(userA: string, userB: string): boolean {
  return toUserSlug(userA) === toUserSlug(userB);
}

export function listUserSlugs(users: UsersMap): string[] {
  return Object.keys(users).map(toUserSlug);
}

export function uniqueUserSlugs(users: UsersMap): string[] {
  return [...new Set(listUserSlugs(users))];
}

export function getAllowedTelegramIds(users: UsersMap): number[] {
  return Object.values(users)
    .map((user) => Number(user.channels.telegram?.chat_id || ""))
    .filter((id) => id > 0);
}

export function getTelegramChatId(users: UsersMap, userName: string): string | null {
  const resolvedName = resolveUserName(users, userName);
  const user = resolvedName ? users[resolvedName] : null;
  return user?.channels.telegram?.chat_id || null;
}

export function resolveUserName(users: UsersMap, userName: string): string | null {
  const slug = toUserSlug(userName);
  return users[slug] ? slug : null;
}

export function findUserByTelegramId(users: UsersMap, telegramId: string | number): SteveUser | null {
  const chatId = String(telegramId);
  for (const user of Object.values(users)) {
    if (user.channels.telegram?.chat_id === chatId) {
      return user;
    }
  }
  return null;
}

export function addOrUpdateTelegramUser(users: UsersMap, userName: string, telegramId: string): UsersMap {
  const slug = toUserSlug(userName);
  return {
    ...users,
    [slug]: {
      name: slug,
      channels: {
        ...(users[slug]?.channels || {}),
        telegram: { chat_id: telegramId },
      },
    },
  };
}

export function ensureUser(users: UsersMap, userName: string): UsersMap {
  const slug = toUserSlug(userName);
  if (users[slug]) return users;
  return {
    ...users,
    [slug]: {
      name: slug,
      channels: {},
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeSteveUser(key: string, value: Record<string, unknown>): SteveUser {
  const slug = toUserSlug(typeof value.name === "string" ? value.name : key);
  const channels = isRecord(value.channels) ? value.channels : {};
  const telegram = isRecord(channels.telegram)
    ? channels.telegram
    : isRecord((value as Record<string, unknown>).telegram)
      ? (value as Record<string, unknown>).telegram as Record<string, unknown>
      : null;

  return {
    name: slug,
    channels: {
      ...(telegram && typeof telegram.chat_id === "string"
        ? { telegram: { chat_id: telegram.chat_id } }
        : typeof (telegram as Record<string, unknown> | null)?.chatId === "string"
          ? { telegram: { chat_id: String((telegram as Record<string, unknown>).chatId) } }
          : {}),
    },
  };
}

export function normalizeUsers(input: unknown): { users: UsersMap; migrated: boolean } {
  if (!isRecord(input)) {
    return { users: {}, migrated: false };
  }

  const entries = Object.entries(input);
  const isLegacy = entries.every(([, value]) => typeof value === "string");
  if (isLegacy) {
    let users: UsersMap = {};
    for (const [telegramId, name] of entries) {
      users = addOrUpdateTelegramUser(users, String(name), telegramId);
    }
    return { users, migrated: true };
  }

  const users: UsersMap = {};
  let migrated = false;
  for (const [key, value] of entries) {
    if (!isRecord(value)) {
      migrated = true;
      continue;
    }
    const user = normalizeSteveUser(key, value);
    if (user.name !== key) migrated = true;
    users[user.name] = user;
  }

  return { users, migrated };
}

export function writeUserManifest(dataDir: string, users: UsersMap): void {
  writeFileSync(
    join(dataDir, "users.json"),
    JSON.stringify({ users: uniqueUserSlugs(users) }, null, 2),
    "utf-8",
  );
}
