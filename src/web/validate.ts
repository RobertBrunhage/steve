const USER_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TELEGRAM_ID_RE = /^\d+$/;
const SECRET_KEY_RE = /^[A-Za-z0-9._/-]{1,120}$/;

export function normalizeUserSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function isValidUserSlug(value: string): boolean {
  return USER_SLUG_RE.test(value);
}

export function validateUserSlug(input: string): { ok: true; value: string } | { ok: false; error: string } {
  const value = normalizeUserSlug(input);
  if (!value || !isValidUserSlug(value)) {
    return { ok: false, error: "User names may only use letters, numbers, and hyphens" };
  }
  return { ok: true, value };
}

export function validateTelegramId(input: string): boolean {
  return TELEGRAM_ID_RE.test(input.trim());
}

export function validateSecretKey(input: string): { ok: true; value: string } | { ok: false; error: string } {
  const value = input.trim();
  if (!value) return { ok: false, error: "Name is required" };
  if (!SECRET_KEY_RE.test(value)) {
    return { ok: false, error: "Names may only use letters, numbers, ., _, /, and -" };
  }
  return { ok: true, value };
}
