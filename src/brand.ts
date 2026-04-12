export const APP_NAME = "Kellix";
export const APP_SLUG = "kellix";
export const LEGACY_APP_NAME = "Steve";
export const LEGACY_APP_SLUG = "steve";

export const USERS_VAULT_KEY = `${APP_SLUG}/users`;
export const LEGACY_USERS_VAULT_KEY = `${LEGACY_APP_SLUG}/users`;

export const ADMIN_AUTH_KEY = `${APP_SLUG}/admin_auth`;
export const LEGACY_ADMIN_AUTH_KEY = `${LEGACY_APP_SLUG}/admin_auth`;
export const ADMIN_SESSION_COOKIE = `${APP_SLUG}_session`;
export const BOOTSTRAP_SESSION_COOKIE = `${APP_SLUG}_bootstrap`;

export const OPENCODE_AGENT_NAME = APP_SLUG;
export const LEGACY_OPENCODE_AGENT_NAME = LEGACY_APP_SLUG;
export const OPENCODE_AGENT_FILE = `${APP_SLUG}.md`;
export const LEGACY_OPENCODE_AGENT_FILE = `${LEGACY_APP_SLUG}.md`;

export function readEnv(primary: string, legacy?: string): string | undefined {
  const primaryValue = process.env[primary];
  if (primaryValue !== undefined && primaryValue !== "") return primaryValue;
  if (!legacy) return primaryValue;
  const legacyValue = process.env[legacy];
  return legacyValue !== undefined && legacyValue !== "" ? legacyValue : undefined;
}
