import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import type { Vault } from "../vault/index.js";
import { ADMIN_AUTH_KEY, ADMIN_SESSION_COOKIE, BOOTSTRAP_SESSION_COOKIE, LEGACY_ADMIN_AUTH_KEY } from "../brand.js";

export { ADMIN_AUTH_KEY, ADMIN_SESSION_COOKIE, BOOTSTRAP_SESSION_COOKIE, LEGACY_ADMIN_AUTH_KEY };

const PASSWORD_KEY_LENGTH = 32;

export function migrateLegacyAdminAuthKey(vault: Vault): void {
  const legacyRecord = vault.get(LEGACY_ADMIN_AUTH_KEY);
  if (!legacyRecord) return;

  if (!vault.has(ADMIN_AUTH_KEY)) {
    vault.set(ADMIN_AUTH_KEY, legacyRecord as any);
  }
  vault.delete(LEGACY_ADMIN_AUTH_KEY);
}

export interface PasswordHashRecord {
  salt: string;
  hash: string;
}

export interface SessionRecord {
  id: string;
  csrfToken: string;
  createdAt: number;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashPassword(password: string): PasswordHashRecord {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, PASSWORD_KEY_LENGTH);
  return {
    salt: salt.toString("base64"),
    hash: hash.toString("base64"),
  };
}

export function isPasswordHashRecord(value: unknown): value is PasswordHashRecord {
  return !!value
    && typeof value === "object"
    && typeof (value as PasswordHashRecord).salt === "string"
    && typeof (value as PasswordHashRecord).hash === "string";
}

export function verifyPassword(password: string, record: unknown): boolean {
  if (!isPasswordHashRecord(record)) return false;

  try {
    const salt = Buffer.from(record.salt, "base64");
    const expected = Buffer.from(record.hash, "base64");
    const actual = scryptSync(password, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function createSessionRecord(): SessionRecord {
  return {
    id: randomToken(24),
    csrfToken: randomToken(24),
    createdAt: Date.now(),
  };
}

export function getCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;

  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq);
    if (key !== name) continue;
    return decodeURIComponent(trimmed.slice(eq + 1));
  }

  return null;
}

function serializeCookie(name: string, value: string, opts: { maxAge?: number; httpOnly?: boolean } = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Strict"];

  if (opts.maxAge !== undefined) {
    parts.push(`Max-Age=${opts.maxAge}`);
  }

  if (opts.httpOnly !== false) {
    parts.push("HttpOnly");
  }

  return parts.join("; ");
}

export function setCookie(c: Context, name: string, value: string, opts: { maxAge?: number; httpOnly?: boolean } = {}): void {
  c.header("Set-Cookie", serializeCookie(name, value, opts), { append: true });
}

export function clearCookie(c: Context, name: string): void {
  c.header("Set-Cookie", serializeCookie(name, "", { maxAge: 0 }), { append: true });
}

export function pruneExpiredSessions(store: Map<string, SessionRecord>, maxAgeMs: number): void {
  const cutoff = Date.now() - maxAgeMs;
  for (const [id, session] of store.entries()) {
    if (session.createdAt < cutoff) {
      store.delete(id);
    }
  }
}
