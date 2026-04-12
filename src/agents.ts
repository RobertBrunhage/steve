import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { toUserSlug, type UsersMap, uniqueUserSlugs } from "./users.js";

export interface UserAgentRecord {
  enabled: boolean;
  port: number;
}

export type UserAgentState = Record<string, UserAgentRecord>;

const USER_AGENT_STATE_FILE = "opencode-agents.json";
const USER_AGENT_COMPOSE_FILE = "agents.compose.yml";
const DEFAULT_OPENCODE_IMAGE = "ghcr.io/robertbrunhage/kellix-opencode:main";

function getUserAgentStatePath(): string {
  return join(config.dataDir, USER_AGENT_STATE_FILE);
}

export function getUserAgentComposePath(): string {
  return join(config.stateDir, USER_AGENT_COMPOSE_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeUserAgentRecord(value: unknown): UserAgentRecord | null {
  if (!isRecord(value)) return null;
  const port = Number(value.port);
  if (!Number.isFinite(port) || port <= 0) return null;
  return {
    enabled: value.enabled !== false,
    port,
  };
}

export function readUserAgentState(): UserAgentState {
  try {
    const path = getUserAgentStatePath();
    if (!existsSync(path)) return {};
    const data = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const next: UserAgentState = {};
    for (const [userName, value] of Object.entries(data)) {
      const record = normalizeUserAgentRecord(value);
      if (!record) continue;
      next[toUserSlug(userName)] = record;
    }
    return next;
  } catch {
    return {};
  }
}

export function writeUserAgentState(state: UserAgentState): void {
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(getUserAgentStatePath(), `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

export function allocateUserAgentPort(state: UserAgentState, userName: string): number {
  const name = toUserSlug(userName);
  const existing = state[name]?.port;
  if (existing) return existing;
  const nextPort = Math.max(config.opencodePortBase, ...Object.values(state).map((entry) => entry.port)) + 1;
  return nextPort;
}

export function upsertUserAgentRecord(state: UserAgentState, userName: string, patch: Partial<UserAgentRecord>): UserAgentState {
  const name = toUserSlug(userName);
  const existing = state[name];
  const port = patch.port ?? existing?.port ?? allocateUserAgentPort(state, name);
  return {
    ...state,
    [name]: {
      enabled: patch.enabled ?? existing?.enabled ?? true,
      port,
    },
  };
}

export function syncUserAgentState(users: UsersMap): UserAgentState {
  const current = readUserAgentState();
  const knownUsers = new Set(uniqueUserSlugs(users));
  const next: UserAgentState = {};

  for (const userName of knownUsers) {
    const record = current[userName];
    if (!record) continue;
    next[userName] = record;
  }

  if (JSON.stringify(current) !== JSON.stringify(next)) {
    writeUserAgentState(next);
  }

  return next;
}

export function listEnabledUserAgents(state: UserAgentState): string[] {
  return Object.entries(state)
    .filter(([, record]) => record.enabled)
    .map(([userName]) => userName)
    .sort((a, b) => a.localeCompare(b));
}

function renderComposeServices(state: UserAgentState): string[] {
  const lines: string[] = [];
  for (const [userName, record] of Object.entries(state).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!record.enabled) continue;
    lines.push(
      `  opencode-${userName}:`,
      "    image: ${KELLIX_OPENCODE_IMAGE:-" + DEFAULT_OPENCODE_IMAGE + "}",
      `    container_name: \${KELLIX_PROJECT:-kellix}-opencode-${userName}`,
      "    restart: unless-stopped",
      '    command: ["serve", "--port", "3456", "--hostname", "0.0.0.0"]',
      "    working_dir: /data",
      "    ports:",
      `      - "${record.port}:3456"`,
      "    extra_hosts:",
      '      - "host.docker.internal:host-gateway"',
      "    volumes:",
      "      - type: volume",
      "        source: kellix-data",
      "        target: /data",
      "        volume:",
      `          subpath: users/${userName}`,
      "      - type: volume",
      "        source: kellix-data",
      "        target: /data/shared",
      "        volume:",
      "          subpath: shared",
      "      - type: volume",
      "        source: kellix-data",
      "        target: /root/.local/share/opencode",
      "        volume:",
      `          subpath: users/${userName}/.opencode-data`,
      "    networks: [kellix-net]",
      "",
    );
  }
  return lines;
}

export function renderUserAgentsCompose(state: UserAgentState): string {
  const services = renderComposeServices(state);
  if (services.length === 0) {
    return "services: {}\n";
  }

  return [
    "services:",
    ...services,
    "volumes:",
    "  kellix-data:",
    "    name: ${KELLIX_PROJECT:-kellix}_kellix-data",
    "    external: true",
    "",
    "networks:",
    "  kellix-net:",
    "    name: ${KELLIX_PROJECT:-kellix}_kellix-net",
    "    external: true",
    "",
  ].join("\n");
}

export function writeUserAgentsCompose(state: UserAgentState): void {
  mkdirSync(config.stateDir, { recursive: true });
  writeFileSync(getUserAgentComposePath(), renderUserAgentsCompose(state), "utf-8");
}

export function syncUserAgentsRuntime(users: UsersMap): UserAgentState {
  const state = syncUserAgentState(users);
  writeUserAgentsCompose(state);
  return state;
}
