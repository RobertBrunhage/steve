export type BrowserTarget = "container" | "remote";

export type ChromeChannel = "stable" | "beta" | "dev" | "canary";

export interface AttachedBrowserConfig {
  mode: "local_chrome";
  channel: ChromeChannel;
  updatedAt: string;
  lastConnectedAt?: string | null;
  lastError?: string | null;
}

export interface BrowserSettings {
  enabled: boolean;
  defaultTarget: BrowserTarget;
  artifactsRetentionDays: number;
  remoteEnabled: boolean;
  remoteBaseUrl: string;
}

export interface BrowserSessionState {
  viewerPort: number;
  vncPort: number;
  display: number;
}

export type BrowserStateMap = Record<string, BrowserSessionState>;

export interface BrowserActionResult {
  ok: boolean;
  status: "ok" | "auth_required" | "waiting_for_user" | "error";
  url?: string;
  title?: string;
  text?: string;
  elements?: Array<{ ref: string; role: string; name: string }>;
  viewerUrl?: string;
  screenshotPath?: string;
  downloadPath?: string;
  message?: string;
  error?: string;
}

export interface BrowserService {
  open(input: { userName: string; url: string; target?: BrowserTarget }): Promise<BrowserActionResult>;
  snapshot(input: { userName: string; target?: BrowserTarget }): Promise<BrowserActionResult>;
  click(input: { userName: string; ref: string; target?: BrowserTarget }): Promise<BrowserActionResult>;
  type(input: { userName: string; ref: string; text: string; submit?: boolean; target?: BrowserTarget }): Promise<BrowserActionResult>;
  wait(input: { userName: string; text?: string; ref?: string; timeoutMs?: number; target?: BrowserTarget }): Promise<BrowserActionResult>;
  screenshot(input: { userName: string; fullPage?: boolean; target?: BrowserTarget }): Promise<BrowserActionResult>;
  download(input: { userName: string; ref: string; target?: BrowserTarget }): Promise<BrowserActionResult>;
  close(userName: string): Promise<void>;
  stopAll(): Promise<void>;
}
