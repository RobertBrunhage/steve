import type { Vault } from "./vault/index.js";
import { toUserSlug } from "./users.js";

export const SYSTEM_TELEGRAM_BOT_TOKEN_KEY = "system/telegram/bot_token";

export interface UserAppSecretSummary {
  integration: string;
  fields: string[];
}

function parseNewUserAppKey(key: string): { user: string; integration: string } | null {
  const match = key.match(/^users\/([^/]+)\/([^/]+)\/app$/i);
  if (!match) return null;
  return { user: toUserSlug(match[1]), integration: match[2].toLowerCase() };
}

export function getTelegramBotToken(vault: Vault | null): string | null {
  if (!vault) return null;
  return vault.getString(SYSTEM_TELEGRAM_BOT_TOKEN_KEY) || null;
}

export function setTelegramBotToken(vault: Vault, token: string): void {
  vault.set(SYSTEM_TELEGRAM_BOT_TOKEN_KEY, token as any);
}

export function hasTelegramBotToken(vault: Vault | null): boolean {
  return !!getTelegramBotToken(vault);
}

export function getUserAppSecretKey(userName: string, integration: string): string {
  return `users/${toUserSlug(userName)}/${integration.toLowerCase()}/app`;
}

export function getUserTokensSecretKey(userName: string, integration: string): string {
  return `users/${toUserSlug(userName)}/${integration.toLowerCase()}/tokens`;
}

export function getUserAppSecret(vault: Vault | null, userName: string, integration: string): { key: string; value: Record<string, unknown> | string } | null {
  if (!vault) return null;
  const key = getUserAppSecretKey(userName, integration);
  const value = vault.get(key) ?? vault.getString(key);
  return value === null ? null : { key, value };
}

export function setUserAppSecret(vault: Vault, userName: string, integration: string, fields: Record<string, string>): void {
  vault.set(getUserAppSecretKey(userName, integration), fields as any);
}

export function deleteUserAppSecret(vault: Vault, userName: string, integration: string): void {
  vault.delete(getUserAppSecretKey(userName, integration));
}

export function listUserAppSecrets(vault: Vault | null, userName: string): UserAppSecretSummary[] {
  if (!vault) return [];

  const slug = toUserSlug(userName);
  const integrations = new Map<string, UserAppSecretSummary>();

  for (const key of vault.list()) {
    const parsed = parseNewUserAppKey(key);
    if (!parsed || parsed.user !== slug) continue;

    const value = vault.get(key);
    const fields = value && typeof value === "object" ? Object.keys(value) : [key.split("/").pop() || "value"];

    if (!integrations.has(parsed.integration)) {
      integrations.set(parsed.integration, {
        integration: parsed.integration,
        fields,
      });
    }
  }

  return [...integrations.values()].sort((a, b) => a.integration.localeCompare(b.integration));
}
