import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { toUserSlug } from "../users.js";
import type { BrowserSessionState, BrowserStateMap } from "./types.js";

const STATE_FILE = "browser-state.json";

function getStatePath(): string {
  return join(config.dataDir, STATE_FILE);
}

export function readBrowserState(): BrowserStateMap {
  try {
    const path = getStatePath();
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as BrowserStateMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeBrowserState(state: BrowserStateMap): void {
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(getStatePath(), `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

export function getOrAllocateBrowserState(userName: string): BrowserSessionState {
  const slug = toUserSlug(userName);
  const state = readBrowserState();
  if (state[slug]) return state[slug]!;

  const entries = Object.values(state);
  const viewerPort = Math.max(config.browserViewerPortBase - 1, ...entries.map((entry) => entry.viewerPort)) + 1;
  const vncPort = Math.max(config.browserVncPortBase - 1, ...entries.map((entry) => entry.vncPort)) + 1;
  const display = Math.max(config.browserDisplayBase - 1, ...entries.map((entry) => entry.display)) + 1;

  const next = { viewerPort, vncPort, display };
  state[slug] = next;
  writeBrowserState(state);
  return next;
}
