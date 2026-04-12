import type { Page } from "playwright-core";

export const REF_ATTR = "data-kellix-browser-ref";

export interface BrowserSnapshot {
  text: string;
  elements: Array<{ ref: string; role: string; name: string }>;
}

export async function buildSnapshot(page: Page): Promise<BrowserSnapshot> {
  return page.evaluate((refAttr: string) => {
    function visible(el: Element): boolean {
      const html = el as HTMLElement;
      const style = window.getComputedStyle(html);
      const rect = html.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    }

    const interactive = Array.from(document.querySelectorAll('a, button, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]'))
      .filter(visible);

    interactive.forEach((el, index) => {
      el.setAttribute(refAttr, `e${index + 1}`);
    });

    const elements = interactive.map((el) => {
      const ref = el.getAttribute(refAttr) || "";
      const role = el.getAttribute("role") || el.tagName.toLowerCase();
      const name = (el.getAttribute("aria-label") || (el as HTMLInputElement).placeholder || (el.textContent || "").trim() || role).slice(0, 120);
      return { ref, role, name };
    });

    const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 5000);
    return { text, elements };
  }, REF_ATTR);
}

export function looksLikeAuthRequired(url: string, text: string): boolean {
  const lower = `${url} ${text}`.toLowerCase();
  return ["sign in", "log in", "login", "verify it\'s you", "two-factor", "2fa", "enter code", "password", "browser or app may not be secure"].some((token) => lower.includes(token));
}

export function getTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
