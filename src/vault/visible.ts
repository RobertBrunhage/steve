import type { Vault } from "./index.js";

export const HIDDEN_VAULT_KEYS = new Set(["kellix/admin_auth", "kellix/users", "steve/admin_auth", "steve/users"]);

export function isVisibleVaultKey(key: string): boolean {
  return !HIDDEN_VAULT_KEYS.has(key);
}

export function listVisibleVaultKeys(vault: Vault | null): string[] {
  return (vault?.list() ?? []).filter(isVisibleVaultKey);
}
