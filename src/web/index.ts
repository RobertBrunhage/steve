import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { getBaseUrl, readSystemSettings } from "../config.js";
import type { Vault } from "../vault/index.js";
import {
  ADMIN_SESSION_COOKIE,
  BOOTSTRAP_SESSION_COOKIE,
  clearCookie,
  createSessionRecord,
  getCookie,
  pruneExpiredSessions,
  randomToken,
  setCookie,
  type SessionRecord,
} from "./auth.js";
import { clearSetupToken, readSetupToken, writeSetupToken } from "./common.js";
import { registerBrowserRoutes } from "./browser-routes.js";
import { registerSecretsRoutes } from "./secrets-routes.js";
import { registerSetupRoutes } from "./setup-routes.js";
import { registerUsersRoutes } from "./users-routes.js";
import { getComposeProject } from "./docker.js";
import { renderSetup } from "./views.js";
import type { AdminFormResult, WebRouteDeps, WebServerHandle, WebServerOptions } from "./types.js";

const ADMIN_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const BOOTSTRAP_SESSION_MAX_AGE_MS = 30 * 60 * 1000;
const ADMIN_COOKIE_MAX_AGE_SECONDS = ADMIN_SESSION_MAX_AGE_MS / 1000;

export function startWebServer(vault: Vault | null, port: number, options: WebServerOptions = {}): WebServerHandle {
  let currentVault = vault;
  const adminSessions = new Map<string, SessionRecord>();
  const bootstrapSessions = new Map<string, SessionRecord>();
  const app = new Hono();

  function getVault() {
    return currentVault;
  }

  function setVault(nextVault: Vault) {
    currentVault = nextVault;
  }

  function getAdminAuthRecord(): unknown {
    return currentVault?.get("steve/admin_auth") ?? null;
  }

  function isAdminConfigured(): boolean {
    return currentVault !== null && !!getAdminAuthRecord();
  }

  function ensureSetupToken(): string | null {
    if (isAdminConfigured()) {
      clearSetupToken();
      return null;
    }

    const existing = readSetupToken();
    if (existing) return existing.token;

    const created = { token: randomToken(24), createdAt: Date.now() };
    writeSetupToken(created);
    return created.token;
  }

  function getSession(store: Map<string, SessionRecord>, cookieName: string, cookieHeader: string | undefined, maxAgeMs: number): SessionRecord | null {
    pruneExpiredSessions(store, maxAgeMs);
    const id = getCookie(cookieHeader, cookieName);
    if (!id) return null;
    return store.get(id) ?? null;
  }

  function issueSession(c: Context, store: Map<string, SessionRecord>, cookieName: string, maxAgeMs: number, maxAgeSeconds: number): SessionRecord {
    pruneExpiredSessions(store, maxAgeMs);
    const session = createSessionRecord();
    store.set(session.id, session);
    setCookie(c, cookieName, session.id, { maxAge: maxAgeSeconds });
    return session;
  }

  function getAdminSession(c: Context): SessionRecord | null {
    return getSession(adminSessions, ADMIN_SESSION_COOKIE, c.req.header("cookie"), ADMIN_SESSION_MAX_AGE_MS);
  }

  function getBootstrapSession(c: Context): SessionRecord | null {
    return getSession(bootstrapSessions, BOOTSTRAP_SESSION_COOKIE, c.req.header("cookie"), BOOTSTRAP_SESSION_MAX_AGE_MS);
  }

  function issueAdminSession(c: Context): SessionRecord {
    const session = issueSession(c, adminSessions, ADMIN_SESSION_COOKIE, ADMIN_SESSION_MAX_AGE_MS, ADMIN_COOKIE_MAX_AGE_SECONDS);
    clearCookie(c, BOOTSTRAP_SESSION_COOKIE);
    return session;
  }

  function issueBootstrapSession(c: Context): SessionRecord {
    return issueSession(c, bootstrapSessions, BOOTSTRAP_SESSION_COOKIE, BOOTSTRAP_SESSION_MAX_AGE_MS, BOOTSTRAP_SESSION_MAX_AGE_MS / 1000);
  }

  function clearSession(c: Context, store: Map<string, SessionRecord>, cookieName: string): void {
    const sessionId = getCookie(c.req.header("cookie"), cookieName);
    if (sessionId) store.delete(sessionId);
    clearCookie(c, cookieName);
  }

  function clearAdminSession(c: Context): void {
    clearSession(c, adminSessions, ADMIN_SESSION_COOKIE);
  }

  function clearBootstrapSession(c: Context): void {
    clearSession(c, bootstrapSessions, BOOTSTRAP_SESSION_COOKIE);
  }

  function requireAdminPage(c: Context): SessionRecord | Response {
    const session = getAdminSession(c);
    if (!session) return c.redirect("/login");
    return session;
  }

  function requireAdminApi(c: Context): SessionRecord | Response {
    const session = getAdminSession(c);
    if (!session) return c.json({ error: "Unauthorized" }, 401);
    return session;
  }

  async function requireAdminForm(c: Context): Promise<AdminFormResult | Response> {
    const session = requireAdminPage(c);
    if (session instanceof Response) return session;
    const body = await c.req.parseBody();
    if (String(body._csrf || "") !== session.csrfToken) {
      return c.text("Invalid CSRF token", 403);
    }
    return { session, body };
  }

  function buildSetupView(csrfToken: string, error?: string, authOnly = false, timezone?: string): string {
    return renderSetup({
      needsVaultPassword: !currentVault,
      csrfToken,
      error,
      authOnly,
      timezone: timezone || readSystemSettings().timezone,
    });
  }

  const deps: WebRouteDeps = {
    composeProject: getComposeProject(),
    telegramFetch: options.telegramFetch ?? fetch,
    getVault,
    setVault,
    isAdminConfigured,
    getAdminAuthRecord,
    ensureSetupToken,
    clearSetupToken,
    issueAdminSession,
    issueBootstrapSession,
    getAdminSession,
    getBootstrapSession,
    clearAdminSession,
    clearBootstrapSession,
    requireAdminPage,
    requireAdminApi,
    requireAdminForm,
    buildSetupView,
  };

  registerSetupRoutes(app, deps);
  registerBrowserRoutes(app, deps);
  registerSecretsRoutes(app, deps);
  registerUsersRoutes(app, deps);

  if (options.listen !== false) {
    serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
  }

  const token = ensureSetupToken();
  return {
    app,
    setupUrl: token ? `${getBaseUrl()}/setup?token=${encodeURIComponent(token)}` : null,
  };
}
