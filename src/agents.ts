import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_SLUG } from "./brand.js";
import { config } from "./config.js";
import { readUserAgentsConfig } from "./user-agents.js";
import { toUserSlug, type UsersMap, uniqueUserSlugs } from "./users.js";

export interface UserAgentRecord {
  enabled: boolean;
  port: number;
}

/** State keyed by user → agentId → record. */
export type UserAgentState = Record<string, Record<string, UserAgentRecord>>;

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
  return { enabled: value.enabled !== false, port };
}

export function readUserAgentState(): UserAgentState {
  try {
    const path = getUserAgentStatePath();
    if (!existsSync(path)) return {};
    const data = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const next: UserAgentState = {};
    for (const [userName, value] of Object.entries(data)) {
      const user = toUserSlug(userName);
      if (!isRecord(value)) continue;
      // Legacy single-record shape: { [user]: { enabled, port } } — promote to kellix agent.
      if ("port" in value || "enabled" in value) {
        const record = normalizeUserAgentRecord(value);
        if (record) next[user] = { [APP_SLUG]: record };
        continue;
      }
      // New nested shape: { [user]: { [agentId]: { enabled, port } } }
      const agents: Record<string, UserAgentRecord> = {};
      for (const [agentId, agentValue] of Object.entries(value)) {
        const record = normalizeUserAgentRecord(agentValue);
        if (record) agents[toUserSlug(agentId)] = record;
      }
      if (Object.keys(agents).length > 0) next[user] = agents;
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

function allPorts(state: UserAgentState): number[] {
  return Object.values(state).flatMap((agents) => Object.values(agents).map((entry) => entry.port));
}

export function allocateUserAgentPort(state: UserAgentState, userName: string, agentId: string): number {
  const user = toUserSlug(userName);
  const id = toUserSlug(agentId);
  const existing = state[user]?.[id]?.port;
  if (existing) return existing;
  const ports = allPorts(state);
  const base = ports.length === 0 ? config.opencodePortBase : Math.max(config.opencodePortBase, ...ports);
  return base + 1;
}

export function upsertUserAgentRecord(state: UserAgentState, userName: string, agentId: string, patch: Partial<UserAgentRecord>): UserAgentState {
  const user = toUserSlug(userName);
  const id = toUserSlug(agentId);
  const existing = state[user]?.[id];
  const port = patch.port ?? existing?.port ?? allocateUserAgentPort(state, user, id);
  return {
    ...state,
    [user]: {
      ...(state[user] || {}),
      [id]: {
        enabled: patch.enabled ?? existing?.enabled ?? true,
        port,
      },
    },
  };
}

export function removeUserAgentRecord(state: UserAgentState, userName: string, agentId: string): UserAgentState {
  const user = toUserSlug(userName);
  const id = toUserSlug(agentId);
  const userAgents = state[user];
  if (!userAgents || !(id in userAgents)) return state;
  const { [id]: _removed, ...rest } = userAgents;
  if (Object.keys(rest).length === 0) {
    const { [user]: _user, ...next } = state;
    return next;
  }
  return { ...state, [user]: rest };
}

export function getUserAgentRecord(state: UserAgentState, userName: string, agentId: string): UserAgentRecord | undefined {
  return state[toUserSlug(userName)]?.[toUserSlug(agentId)];
}

export function syncUserAgentState(users: UsersMap): UserAgentState {
  const current = readUserAgentState();
  const knownUsers = new Set(uniqueUserSlugs(users));
  const next: UserAgentState = {};

  for (const user of knownUsers) {
    const agents = current[user];
    if (!agents) continue;
    const validIds = new Set(readUserAgentsConfig(user).agents.map((agent) => agent.id));
    const keep: Record<string, UserAgentRecord> = {};
    for (const [agentId, record] of Object.entries(agents)) {
      if (validIds.has(agentId)) keep[agentId] = record;
    }
    if (Object.keys(keep).length > 0) next[user] = keep;
  }

  if (JSON.stringify(current) !== JSON.stringify(next)) {
    writeUserAgentState(next);
  }
  return next;
}

export interface EnabledUserAgent {
  userName: string;
  agentId: string;
  port: number;
}

export function listEnabledUserAgents(state: UserAgentState): EnabledUserAgent[] {
  const out: EnabledUserAgent[] = [];
  for (const [userName, agents] of Object.entries(state)) {
    for (const [agentId, record] of Object.entries(agents)) {
      if (record.enabled) out.push({ userName, agentId, port: record.port });
    }
  }
  return out.sort((a, b) => `${a.userName}/${a.agentId}`.localeCompare(`${b.userName}/${b.agentId}`));
}

function renderComposeServices(state: UserAgentState): string[] {
  const lines: string[] = [];
  const entries: Array<{ userName: string; agentId: string; record: UserAgentRecord }> = [];
  for (const [userName, agents] of Object.entries(state)) {
    for (const [agentId, record] of Object.entries(agents)) {
      entries.push({ userName, agentId, record });
    }
  }
  entries.sort((a, b) => `${a.userName}/${a.agentId}`.localeCompare(`${b.userName}/${b.agentId}`));

  for (const { userName, agentId, record } of entries) {
    if (!record.enabled) continue;
    const service = `opencode-${userName}-${agentId}`;
    const containerName = `\${KELLIX_PROJECT:-kellix}-opencode-${userName}-${agentId}`;
    const subpathData = `users/${userName}/agents/${agentId}`;
    const subpathState = `users/${userName}/agents/${agentId}/.opencode-data`;
    lines.push(
      `  ${service}:`,
      "    image: ${KELLIX_OPENCODE_IMAGE:-" + DEFAULT_OPENCODE_IMAGE + "}",
      `    container_name: ${containerName}`,
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
      `          subpath: ${subpathData}`,
      "      - type: volume",
      "        source: kellix-data",
      "        target: /data/shared",
      "        volume:",
      "          subpath: shared",
      "      - type: volume",
      "        source: kellix-data",
      "        target: /root/.local/share/opencode",
      "        volume:",
      `          subpath: ${subpathState}`,
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
