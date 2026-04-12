import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Vault } from "./vault/index.js";
import { LEGACY_USERS_VAULT_KEY, USERS_VAULT_KEY } from "./brand.js";

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
  const telegram = isRecord(channels.telegram) ? channels.telegram : null;

  return {
    name: slug,
    channels: {
      ...(telegram && typeof telegram.chat_id === "string"
        ? { telegram: { chat_id: telegram.chat_id } }
          : {}),
    },
  };
}

export function normalizeUsers(input: unknown): { users: UsersMap } {
  if (!isRecord(input)) {
    return { users: {} };
  }

  const users: UsersMap = {};
  for (const [key, value] of Object.entries(input)) {
    if (!isRecord(value)) {
      continue;
    }
    const user = normalizeSteveUser(key, value);
    users[user.name] = user;
  }

  return { users };
}

export function readUsersFromVault(vault: Vault | null): UsersMap {
  if (!vault) return {};
  return normalizeUsers(vault.get(USERS_VAULT_KEY) ?? vault.get(LEGACY_USERS_VAULT_KEY)).users;
}

export function writeUsersToVault(vault: Vault, users: UsersMap): void {
  vault.set(USERS_VAULT_KEY, users as any);
  if (vault.has(LEGACY_USERS_VAULT_KEY)) {
    vault.delete(LEGACY_USERS_VAULT_KEY);
  }
}

export function migrateUsersVaultKey(vault: Vault): void {
  const legacyUsers = vault.get(LEGACY_USERS_VAULT_KEY);
  if (!legacyUsers) return;

  if (!vault.has(USERS_VAULT_KEY)) {
    vault.set(USERS_VAULT_KEY, legacyUsers as any);
  }
  vault.delete(LEGACY_USERS_VAULT_KEY);
}

export function writeUserManifest(dataDir: string, users: UsersMap): void {
  writeFileSync(
    join(dataDir, "users.json"),
    JSON.stringify({ users: uniqueUserSlugs(users) }, null, 2),
    "utf-8",
  );
}
