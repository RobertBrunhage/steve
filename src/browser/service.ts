import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { config, getBrowserSettings, getBrowserViewerUrl } from "../config.js";
import { toUserSlug } from "../users.js";
import { readAttachedBrowserConfig, updateAttachedBrowserConfig } from "./attachments.js";
import { getOrAllocateBrowserState } from "./state.js";
import type { AttachedBrowserConfig, BrowserActionResult, BrowserService, BrowserTarget } from "./types.js";
import { buildSnapshot, getTimestamp, looksLikeAuthRequired, REF_ATTR } from "./common.js";
import { getPreferredBrowserTarget, setPreferredBrowserTarget } from "./preferences.js";

interface RuntimeSession {
  context: BrowserContext;
  page: Page;
  processes: ChildProcess[];
  viewerUrl: string;
}

const VIEWPORT = { width: 1440, height: 900 };
const XVFB_SCREEN = `${VIEWPORT.width}x${VIEWPORT.height}x24`;
const REMOTE_PREFERRED_DOMAINS = ["amazon.", "accounts.google.com", "twitter.com", "x.com", "login.microsoftonline.com"];

function getHostname(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return rawUrl.toLowerCase();
  }
}

function shouldEscalateToRemote(url: string, text: string): boolean {
  const lower = `${getHostname(url)} ${text}`.toLowerCase();
  return [
    "browser or app may not be secure",
    "controlled by automated test software",
    "this browser or app may not be secure",
    "sign-in rejected",
  ].some((token) => lower.includes(token));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getProfileRoot(userName: string): string {
  return join(config.usersDir, toUserSlug(userName), ".browser");
}

function getProfileDir(userName: string): string {
  return join(getProfileRoot(userName), "profile");
}

function getScreenshotsDir(userName: string): string {
  return join(getProfileRoot(userName), "screenshots");
}

function getDownloadsDir(userName: string): string {
  return join(getProfileRoot(userName), "downloads");
}

function ensureBrowserDirs(userName: string): void {
  mkdirSync(getProfileDir(userName), { recursive: true });
  mkdirSync(getScreenshotsDir(userName), { recursive: true });
  mkdirSync(getDownloadsDir(userName), { recursive: true });
}

function looksLikeProfileLockError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return lower.includes("singletonlock")
    || lower.includes("processsingleton")
    || lower.includes("profile appears to be in use")
    || lower.includes("user data directory is already in use")
    || lower.includes("another process");
}

function clearChromiumProfileLocks(profileDir: string): void {
  for (const fileName of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    rmSync(join(profileDir, fileName), { force: true });
  }
}

function stopManagedProcesses(processes: ChildProcess[]): void {
  for (const child of processes) {
    child.kill("SIGTERM");
  }
}

function spawnManaged(command: string, args: string[], env: NodeJS.ProcessEnv = {}): ChildProcess {
  const child = spawn(command, args, {
    stdio: "ignore",
    detached: false,
    env: { ...process.env, ...env },
  });
  child.on("error", () => {});
  return child;
}

async function waitForUrl(url: string, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 405) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

export class PlaywrightBrowserService implements BrowserService {
  private sessions = new Map<string, RuntimeSession>();

  private getUserKey(userName: string) {
    return toUserSlug(userName);
  }

  private async ensureContainerSession(userName: string): Promise<RuntimeSession> {
    const key = this.getUserKey(userName);
    const existing = this.sessions.get(key);
    if (existing && !existing.page.isClosed()) {
      return existing;
    }

    ensureBrowserDirs(userName);
    const browserState = getOrAllocateBrowserState(userName);
    const displayName = `:${browserState.display}`;
    const profileDir = getProfileDir(userName);
    const downloadsDir = getDownloadsDir(userName);
    const xvfb = spawnManaged("Xvfb", [displayName, "-screen", "0", XVFB_SCREEN, "-ac"]);
    const fluxbox = spawnManaged("fluxbox", [], { DISPLAY: displayName });
    const x11vnc = spawnManaged("x11vnc", ["-display", displayName, "-rfbport", String(browserState.vncPort), "-localhost", "-nopw", "-forever", "-shared"]);
    const websockify = spawnManaged("websockify", [String(browserState.viewerPort), `localhost:${browserState.vncPort}`, "--web", "/usr/share/novnc"]);
    const processes = [xvfb, fluxbox, x11vnc, websockify];

    try {
      await waitForUrl(`http://127.0.0.1:${browserState.viewerPort}/vnc.html`);
      const launch = async () => chromium.launchPersistentContext(profileDir, {
        executablePath: "/usr/bin/chromium",
        headless: false,
        viewport: VIEWPORT,
        acceptDownloads: true,
        downloadsPath: downloadsDir,
        env: { ...process.env, DISPLAY: displayName },
        args: [
          `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--no-first-run",
          "--disable-features=Translate,MediaRouter",
        ],
      });

      let context: BrowserContext;
      try {
        context = await launch();
      } catch (error) {
        if (!looksLikeProfileLockError(error)) throw error;
        clearChromiumProfileLocks(profileDir);
        context = await launch();
      }

      const page = context.pages()[0] || await context.newPage();
      const session: RuntimeSession = {
        context,
        page,
        processes,
        viewerUrl: getBrowserViewerUrl(browserState.viewerPort),
      };
      this.sessions.set(key, session);
      return session;
    } catch (error) {
      stopManagedProcesses(processes);
      throw error;
    }
  }

  private async ensureSession(userName: string, target: BrowserTarget = "container"): Promise<RuntimeSession> {
    if (target === "remote") {
      throw new Error("Remote browser target is handled through the remote browser companion API");
    }
    return this.ensureContainerSession(userName);
  }

  private resolveTarget(target?: BrowserTarget): BrowserTarget {
    return target || "container";
  }

  private getRemoteAttach(userName: string): AttachedBrowserConfig | null {
    return readAttachedBrowserConfig(userName);
  }

  private remoteUnavailableResult(input: { userName: string; url: string }): BrowserActionResult {
    return {
      ok: false,
      status: "error",
      url: input.url,
      message: "This site likely needs the attached local Chrome flow, but this Kellix install does not have the remote browser companion available.",
      error: "remote_unavailable",
    };
  }

  private remoteNotConfiguredResult(input: { userName: string; url: string }): BrowserActionResult {
    return {
      ok: false,
      status: "error",
      url: input.url,
      message: `This site likely needs ${input.userName}'s attached Chrome, but that user has not attached a local browser yet. Open the user's page in Kellix and attach local Chrome first.`,
      error: "remote_not_configured",
    };
  }

  private remoteUrl(path: string): string {
    const settings = getBrowserSettings();
    if (!settings.remoteEnabled || !settings.remoteBaseUrl) {
      throw new Error("Remote browser companion is not available on this Kellix install");
    }
    return `${settings.remoteBaseUrl.replace(/\/$/, "")}${path}`;
  }

  private async remoteRequest<T>(path: string, body: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.remoteUrl(path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error("Remote browser companion is not running. Start it with `kellix browser up`.");
    }
    if (!res.ok) {
      throw new Error(`Remote browser companion request failed: ${res.status}`);
    }
    return res.json() as Promise<T>;
  }

  private shouldPreferRemote(url: string): boolean {
    const lower = getHostname(url);
    return REMOTE_PREFERRED_DOMAINS.some((domain) => lower.includes(domain));
  }

  private markRemoteConnected(userName: string): void {
    updateAttachedBrowserConfig(userName, {
      lastConnectedAt: new Date().toISOString(),
      lastError: null,
    });
  }

  private markRemoteError(userName: string, error: string): void {
    updateAttachedBrowserConfig(userName, { lastError: error });
  }

  private async openRemote(input: { userName: string; url: string }): Promise<BrowserActionResult> {
    const attach = this.getRemoteAttach(input.userName);
    if (!attach) return this.remoteNotConfiguredResult(input);
    try {
      const result = await this.remoteRequest<BrowserActionResult>("/api/session/open", { ...input, attach });
      this.markRemoteConnected(input.userName);
      setPreferredBrowserTarget(input.userName, getHostname(input.url), "remote");
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.markRemoteError(input.userName, message);
      return {
        ok: false,
        status: "error",
        url: input.url,
        error: "remote_unavailable",
        message,
      };
    }
  }

  private async remoteAction<T extends Record<string, unknown>>(path: string, body: T & { userName: string }): Promise<BrowserActionResult> {
    const attach = this.getRemoteAttach(body.userName);
    if (!attach) {
      return {
        ok: false,
        status: "error",
        message: `No attached Chrome is configured for ${body.userName}.`,
        error: "remote_not_configured",
      };
    }
    try {
      const result = await this.remoteRequest<BrowserActionResult>(path, { ...body, attach });
      this.markRemoteConnected(body.userName);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.markRemoteError(body.userName, message);
      return {
        ok: false,
        status: "error",
        error: "remote_unavailable",
        message,
      };
    }
  }

  private async withEscalation(input: { userName: string; url: string; target?: BrowserTarget }, action: () => Promise<BrowserActionResult>): Promise<BrowserActionResult> {
    const requestedTarget = input.target;
    const hostname = getHostname(input.url);
    const browserSettings = getBrowserSettings();
    const remoteAvailable = browserSettings.remoteEnabled && !!browserSettings.remoteBaseUrl;
    const attachConfigured = !!this.getRemoteAttach(input.userName);

    if (requestedTarget === "remote") {
      if (!remoteAvailable) return this.remoteUnavailableResult(input);
      if (!attachConfigured) return this.remoteNotConfiguredResult(input);
      return this.openRemote(input);
    }

    const result = await action();
    if (!remoteAvailable || !attachConfigured) {
      return result;
    }
    if (result.status === "auth_required" && (this.shouldPreferRemote(input.url) || shouldEscalateToRemote(result.url || input.url, result.text || ""))) {
      const preferredTarget = getPreferredBrowserTarget(input.userName, hostname);
      return {
        ...result,
        ok: false,
        status: "waiting_for_user",
        message: preferredTarget === "remote"
          ? "This site usually works better in your attached local Chrome. If you want me to switch, tell me to use your attached browser."
          : "This site likely needs your attached local Chrome. If you want me to switch, tell me to use your attached browser.",
      };
    }
    return result;
  }

  private async currentPage(userName: string, target?: BrowserTarget): Promise<{ session: RuntimeSession; page: Page }> {
    const session = await this.ensureSession(userName, target);
    let page = session.page;
    if (page.isClosed()) {
      page = session.context.pages()[0] || await session.context.newPage();
      session.page = page;
    }
    return { session, page };
  }

  private async createResult(page: Page, session: RuntimeSession, message?: string): Promise<BrowserActionResult> {
    const snapshot = await buildSnapshot(page);
    const url = page.url();
    const title = await page.title();
    return {
      ok: true,
      status: looksLikeAuthRequired(url, snapshot.text) ? "auth_required" : "ok",
      url,
      title,
      text: snapshot.text,
      elements: snapshot.elements,
      viewerUrl: session.viewerUrl,
      message,
    };
  }

  async open(input: { userName: string; url: string; target?: BrowserTarget }): Promise<BrowserActionResult> {
    return this.withEscalation(input, async () => {
      const { session, page } = await this.currentPage(input.userName, input.target);
      await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      return this.createResult(page, session, `Opened ${input.url}`);
    });
  }

  async snapshot(input: { userName: string; target?: BrowserTarget }): Promise<BrowserActionResult> {
    if (this.resolveTarget(input.target) === "remote") {
      return this.remoteAction("/api/session/snapshot", input);
    }
    const { session, page } = await this.currentPage(input.userName, input.target);
    return this.createResult(page, session);
  }

  private async locatorFromRef(page: Page, ref: string) {
    const locator = page.locator(`[${REF_ATTR}="${ref}"]`).first();
    const count = await locator.count();
    if (count === 0) {
      throw new Error(`Unknown browser element ref ${ref}. Take a new snapshot first.`);
    }
    return locator;
  }

  async click(input: { userName: string; ref: string; target?: BrowserTarget }): Promise<BrowserActionResult> {
    if (this.resolveTarget(input.target) === "remote") {
      return this.remoteAction("/api/session/click", input);
    }
    const { session, page } = await this.currentPage(input.userName, input.target);
    const locator = await this.locatorFromRef(page, input.ref);
    await locator.click({ timeout: 15000 });
    await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
    return this.createResult(page, session, `Clicked ${input.ref}`);
  }

  async type(input: { userName: string; ref: string; text: string; submit?: boolean; target?: BrowserTarget }): Promise<BrowserActionResult> {
    if (this.resolveTarget(input.target) === "remote") {
      return this.remoteAction("/api/session/type", input);
    }
    const { session, page } = await this.currentPage(input.userName, input.target);
    const locator = await this.locatorFromRef(page, input.ref);
    await locator.fill(input.text, { timeout: 15000 });
    if (input.submit) {
      await locator.press("Enter").catch(async () => {
        await page.keyboard.press("Enter");
      });
    }
    return this.createResult(page, session, `Typed into ${input.ref}`);
  }

  async wait(input: { userName: string; text?: string; ref?: string; timeoutMs?: number; target?: BrowserTarget }): Promise<BrowserActionResult> {
    if (this.resolveTarget(input.target) === "remote") {
      return this.remoteAction("/api/session/wait", input);
    }
    const timeout = input.timeoutMs || 15000;
    const { session, page } = await this.currentPage(input.userName, input.target);
    if (input.ref) {
      const locator = await this.locatorFromRef(page, input.ref);
      await locator.waitFor({ state: "visible", timeout });
    }
    if (input.text) {
      await page.getByText(input.text, { exact: false }).first().waitFor({ state: "visible", timeout });
    }
    if (!input.ref && !input.text) {
      await page.waitForLoadState("domcontentloaded", { timeout });
    }
    return this.createResult(page, session, "Wait completed");
  }

  async screenshot(input: { userName: string; fullPage?: boolean; target?: BrowserTarget }): Promise<BrowserActionResult> {
    if (this.resolveTarget(input.target) === "remote") {
      return this.remoteAction("/api/session/screenshot", input);
    }
    const { session, page } = await this.currentPage(input.userName, input.target);
    const filePath = join(getScreenshotsDir(input.userName), `${getTimestamp()}.png`);
    await page.screenshot({ path: filePath, fullPage: input.fullPage ?? true });
    const result = await this.createResult(page, session, "Screenshot captured");
    result.screenshotPath = filePath;
    return result;
  }

  async download(input: { userName: string; ref: string; target?: BrowserTarget }): Promise<BrowserActionResult> {
    if (this.resolveTarget(input.target) === "remote") {
      return this.remoteAction("/api/session/download", input);
    }
    const { session, page } = await this.currentPage(input.userName, input.target);
    const locator = await this.locatorFromRef(page, input.ref);
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 15000 }),
      locator.click({ timeout: 15000 }),
    ]);
    const fileName = download.suggestedFilename() || `${getTimestamp()}.bin`;
    const destination = join(getDownloadsDir(input.userName), fileName);
    await download.saveAs(destination);
    const result = await this.createResult(page, session, `Downloaded ${fileName}`);
    result.downloadPath = destination;
    return result;
  }

  async close(userName: string): Promise<void> {
    const key = this.getUserKey(userName);
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    await session.context.close().catch(() => {});
    stopManagedProcesses(session.processes);
  }

  async stopAll(): Promise<void> {
    const userNames = [...this.sessions.keys()];
    for (const userName of userNames) {
      await this.close(userName);
    }
  }
}
