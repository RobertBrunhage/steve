import type { Hono } from "hono";
import { getBrowserService } from "../browser/index.js";
import type { BrowserTarget } from "../browser/types.js";
import type { WebRouteDeps } from "./types.js";

export function registerBrowserRoutes(app: Hono, deps: WebRouteDeps) {
  const browser = getBrowserService();

  async function requireAdminJson(c: any) {
    const session = deps.requireAdminApi(c);
    if (session instanceof Response) return { session };
    return { session, body: await c.req.json().catch(() => ({})) };
  }

  app.post("/api/browser/open", async (c) => {
    const result = await requireAdminJson(c);
    if (result.session instanceof Response) return result.session;
    return c.json(await browser.open(result.body as { userName: string; url: string; target?: BrowserTarget }));
  });

  app.post("/api/browser/snapshot", async (c) => {
    const result = await requireAdminJson(c);
    if (result.session instanceof Response) return result.session;
    return c.json(await browser.snapshot(result.body as { userName: string; target?: BrowserTarget }));
  });

  app.post("/api/browser/click", async (c) => {
    const result = await requireAdminJson(c);
    if (result.session instanceof Response) return result.session;
    return c.json(await browser.click(result.body as { userName: string; ref: string; target?: BrowserTarget }));
  });

  app.post("/api/browser/type", async (c) => {
    const result = await requireAdminJson(c);
    if (result.session instanceof Response) return result.session;
    return c.json(await browser.type(result.body as { userName: string; ref: string; text: string; submit?: boolean; target?: BrowserTarget }));
  });

  app.post("/api/browser/wait", async (c) => {
    const result = await requireAdminJson(c);
    if (result.session instanceof Response) return result.session;
    return c.json(await browser.wait(result.body as { userName: string; text?: string; ref?: string; timeoutMs?: number; target?: BrowserTarget }));
  });

  app.post("/api/browser/screenshot", async (c) => {
    const result = await requireAdminJson(c);
    if (result.session instanceof Response) return result.session;
    return c.json(await browser.screenshot(result.body as { userName: string; fullPage?: boolean; target?: BrowserTarget }));
  });

  app.post("/api/browser/download", async (c) => {
    const result = await requireAdminJson(c);
    if (result.session instanceof Response) return result.session;
    return c.json(await browser.download(result.body as { userName: string; ref: string; target?: BrowserTarget }));
  });
}
