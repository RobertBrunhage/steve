import type { Context, Hono } from "hono";
import type { Vault } from "../vault/index.js";
import type { SessionRecord } from "./auth.js";

export interface WebServerOptions {
  listen?: boolean;
  telegramFetch?: typeof fetch;
}

export interface WebServerHandle {
  app: Hono;
  setupUrl: string | null;
}

export interface AdminFormResult {
  session: SessionRecord;
  body: Record<string, string | File>;
}

export interface WebRouteDeps {
  composeProject: string;
  telegramFetch: typeof fetch;
  getVault(): Vault | null;
  setVault(vault: Vault): void;
  isAdminConfigured(): boolean;
  getAdminAuthRecord(): unknown;
  ensureSetupToken(): string | null;
  clearSetupToken(): void;
  issueAdminSession(c: Context): SessionRecord;
  issueBootstrapSession(c: Context): SessionRecord;
  getAdminSession(c: Context): SessionRecord | null;
  getBootstrapSession(c: Context): SessionRecord | null;
  clearAdminSession(c: Context): void;
  clearBootstrapSession(c: Context): void;
  requireAdminPage(c: Context): SessionRecord | Response;
  requireAdminApi(c: Context): SessionRecord | Response;
  requireAdminForm(c: Context): Promise<AdminFormResult | Response>;
  buildSetupView(csrfToken: string, error?: string): string;
}
