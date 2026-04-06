// Flash messages: a tiny abstraction so mutation handlers can show a
// "✓ Saved" toast without each handler reaching for cookies/headers directly.
//
// Two delivery channels, depending on how the request was made:
//
//   1. htmx requests (POST that swaps a fragment) → set the HX-Trigger
//      response header. The client-side toast script listens for the
//      `showToast` event and renders immediately, no reload.
//
//   2. Full-page POST + redirect → set a short-lived `steve_flash` cookie.
//      The next page load reads it, displays a toast, and clears the cookie.

import type { Context } from "hono";
import { setCookie } from "./auth.js";

export type FlashTone = "ok" | "error";

export const FLASH_COOKIE = "steve_flash";

export function setFlash(c: Context, message: string, tone: FlashTone = "ok"): void {
  if (c.req.header("HX-Request")) {
    c.header("HX-Trigger", JSON.stringify({ showToast: { message, tone } }));
    return;
  }
  setCookie(c, FLASH_COOKIE, JSON.stringify({ message, tone }), { maxAge: 30, httpOnly: false });
}
