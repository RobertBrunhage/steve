import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_SLUG } from "./brand.js";
import { getUserAgentDir, getUserDir } from "./config.js";
import { toUserSlug } from "./users.js";

export interface KellixUserAgent {
  id: string;
  name: string;
  setupStatus?: "needs_setup" | "configured";
  roleSummary?: string;
  instructions?: string;
  /** Deprecated compatibility field for agents created before profiles. */
  goal: string;
  default?: boolean;
  createdAt?: string;
  channels?: {
    telegram?: {
      chatId?: string;
    };
  };
}

export interface KellixAgentProfile {
  roleSummary: string;
  instructions: string;
}

export interface KellixUserAgentsConfig {
  defaultAgentId: string;
  agents: KellixUserAgent[];
}

const USER_AGENTS_FILE = "agents.json";
const AGENT_PROFILE_FILE = "AGENTS.md";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeAgentId(value: string): string {
  return toUserSlug(value).replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "") || APP_SLUG;
}

export function getUserAgentsPath(userName: string): string {
  return join(getUserDir(userName), USER_AGENTS_FILE);
}

export function getUserAgentProfilePath(userName: string, agentId: string): string {
  return join(getUserAgentDir(userName, normalizeAgentId(agentId)), AGENT_PROFILE_FILE);
}

export function readUserAgentProfile(userName: string, agentId: string): KellixAgentProfile {
  try {
    const content = readFileSync(getUserAgentProfilePath(userName, agentId), "utf-8");
    const summaryMatch = content.match(/^## Role summary\s+([\s\S]*?)(?:\n## |$)/m);
    const instructionsMatch = content.match(/^## Instructions\s+([\s\S]*?)(?:\n## |$)/m);
    return { roleSummary: (summaryMatch?.[1] || "").trim(), instructions: (instructionsMatch?.[1] || "").trim() };
  } catch {
    return { roleSummary: "", instructions: "" };
  }
}

export function writeUserAgentProfile(userName: string, agentId: string, profile: KellixAgentProfile): void {
  const id = normalizeAgentId(agentId);
  const dir = getUserAgentDir(userName, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(getUserAgentProfilePath(userName, id), `# ${id} Agent Profile\n\n## Role summary\n${profile.roleSummary.trim()}\n\n## Instructions\n${profile.instructions.trim()}\n`, "utf-8");
}

export function getDefaultKellixAgent(): KellixUserAgent {
  return {
    id: APP_SLUG,
    name: "Kellix",
    setupStatus: "configured",
    roleSummary: "Personal household assistant for everyday conversations, memory, skills, and background tasks.",
    instructions: "Use the shared Kellix household instructions, memory, skills, and scheduled task conventions.",
    goal: "Personal household assistant for everyday conversations, memory, skills, and background tasks.",
    default: true,
  };
}

function normalizeAgent(value: unknown): KellixUserAgent | null {
  if (!isRecord(value)) return null;
  const id = normalizeAgentId(String(value.id || ""));
  if (!id) return null;
  const fallback = id === APP_SLUG ? getDefaultKellixAgent() : { id, name: id, goal: "" };
  return {
    id,
    name: String(value.name || fallback.name).trim() || fallback.name,
    setupStatus: value.setupStatus === "configured" ? "configured" : id === APP_SLUG ? "configured" : "needs_setup",
    roleSummary: String(value.roleSummary || value.goal || fallback.roleSummary || fallback.goal || "").trim(),
    instructions: String(value.instructions || fallback.instructions || "").trim(),
    goal: String(value.goal || fallback.goal).trim(),
    default: value.default === true,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : undefined,
    channels: normalizeAgentChannels(value.channels),
  };
}

function normalizeAgentChannels(value: unknown): KellixUserAgent["channels"] | undefined {
  if (!isRecord(value)) return undefined;
  const telegram = isRecord(value.telegram) ? value.telegram : null;
  if (!telegram) return undefined;
  const chatId = typeof telegram.chatId === "string" ? telegram.chatId.trim() : "";
  if (!chatId) return undefined;
  return {
    telegram: {
      chatId,
    },
  };
}

export function readUserAgentsConfig(userName: string): KellixUserAgentsConfig {
  const fallback = getDefaultKellixAgent();
  try {
    const path = getUserAgentsPath(userName);
    if (!existsSync(path)) return { defaultAgentId: fallback.id, agents: [fallback] };
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    const rawAgents = isRecord(parsed) && Array.isArray(parsed.agents) ? parsed.agents : [];
    const agents = rawAgents.map(normalizeAgent).filter((agent): agent is KellixUserAgent => !!agent);
    if (!agents.some((agent) => agent.id === fallback.id)) agents.unshift(fallback);
    const requestedDefault = isRecord(parsed) && typeof parsed.defaultAgentId === "string"
      ? normalizeAgentId(parsed.defaultAgentId)
      : fallback.id;
    const defaultAgentId = agents.some((agent) => agent.id === requestedDefault) ? requestedDefault : fallback.id;
    return {
      defaultAgentId,
      agents: agents.map((agent) => {
        const profile = readUserAgentProfile(userName, agent.id);
        const roleSummary = profile.roleSummary || agent.roleSummary || agent.goal || "";
        const instructions = profile.instructions || agent.instructions || "";
        return { ...agent, roleSummary, instructions, default: agent.id === defaultAgentId };
      }),
    };
  } catch {
    return { defaultAgentId: fallback.id, agents: [fallback] };
  }
}

export function writeUserAgentsConfig(userName: string, config: KellixUserAgentsConfig): void {
  const userDir = getUserDir(userName);
  mkdirSync(userDir, { recursive: true });
  const fallback = getDefaultKellixAgent();
  const seen = new Set<string>();
  const agents = [fallback, ...config.agents]
    .map(normalizeAgent)
    .filter((agent): agent is KellixUserAgent => !!agent)
    .filter((agent) => {
      if (seen.has(agent.id)) return false;
      seen.add(agent.id);
      return true;
    });
  const defaultAgentId = agents.some((agent) => agent.id === config.defaultAgentId) ? config.defaultAgentId : fallback.id;
  // agents.json is registry/control-plane only. Role + instructions live in
  // each agent's AGENTS.md so the agent owns its own profile.
  writeFileSync(
    getUserAgentsPath(userName),
    `${JSON.stringify({
      defaultAgentId,
      agents: agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        setupStatus: agent.setupStatus,
        default: agent.id === defaultAgentId,
        createdAt: agent.createdAt,
        channels: agent.channels,
      })),
    }, null, 2)}\n`,
    "utf-8",
  );
}

export function resolveUserAgentId(userName: string, requestedAgentId?: string): string {
  const config = readUserAgentsConfig(userName);
  const requested = requestedAgentId ? normalizeAgentId(requestedAgentId) : config.defaultAgentId;
  return config.agents.some((agent) => agent.id === requested) ? requested : config.defaultAgentId;
}

export function upsertUserKellixAgent(userName: string, agent: Omit<KellixUserAgent, "createdAt"> & { createdAt?: string }): KellixUserAgentsConfig {
  const config = readUserAgentsConfig(userName);
  const id = normalizeAgentId(agent.id);
  const next: KellixUserAgent = {
    id,
    name: agent.name.trim() || id,
    setupStatus: agent.setupStatus || (id === APP_SLUG ? "configured" : "needs_setup"),
    roleSummary: (agent.roleSummary || agent.goal || "").trim(),
    instructions: (agent.instructions || "").trim(),
    goal: (agent.goal || agent.roleSummary || "").trim(),
    default: agent.default === true,
    createdAt: agent.createdAt || config.agents.find((entry) => entry.id === id)?.createdAt || new Date().toISOString(),
    channels: agent.channels,
  };
  const agents = config.agents.filter((entry) => entry.id !== id).concat(next);
  const defaultAgentId = next.default ? id : config.defaultAgentId;
  const nextConfig = { defaultAgentId, agents };
  writeUserAgentsConfig(userName, nextConfig);
  // agents.json is registry-only — persist role/instructions to AGENTS.md so
  // they survive across restarts and are readable by the agent itself.
  if (next.roleSummary || next.instructions) {
    writeUserAgentProfile(userName, id, {
      roleSummary: next.roleSummary || "",
      instructions: next.instructions || "",
    });
  }
  return readUserAgentsConfig(userName);
}

export function updateUserAgentProfile(userName: string, agentId: string, profile: { roleSummary?: string; instructions?: string; setupStatus?: "needs_setup" | "configured" }): KellixUserAgentsConfig {
  const config = readUserAgentsConfig(userName);
  const id = normalizeAgentId(agentId);
  const agents = config.agents.map((agent) => {
    if (agent.id !== id) return agent;
    const roleSummary = profile.roleSummary !== undefined ? profile.roleSummary.trim() : agent.roleSummary || agent.goal || "";
    const instructions = profile.instructions !== undefined ? profile.instructions.trim() : agent.instructions || "";
    const setupStatus = profile.setupStatus || (roleSummary || instructions ? "configured" : agent.setupStatus || "needs_setup");
    return {
      ...agent,
      setupStatus,
      roleSummary,
      instructions,
      goal: roleSummary || agent.goal,
    };
  });
  writeUserAgentsConfig(userName, { ...config, agents });
  const updated = agents.find((agent) => agent.id === id);
  if (updated) writeUserAgentProfile(userName, id, { roleSummary: updated.roleSummary || "", instructions: updated.instructions || "" });
  return readUserAgentsConfig(userName);
}

export function setDefaultUserAgent(userName: string, agentId: string): KellixUserAgentsConfig {
  const config = readUserAgentsConfig(userName);
  const id = normalizeAgentId(agentId);
  const defaultAgentId = config.agents.some((agent) => agent.id === id) ? id : config.defaultAgentId;
  writeUserAgentsConfig(userName, { ...config, defaultAgentId });
  return readUserAgentsConfig(userName);
}

export function deleteUserKellixAgent(userName: string, agentId: string): KellixUserAgentsConfig {
  const config = readUserAgentsConfig(userName);
  const id = normalizeAgentId(agentId);
  if (id === APP_SLUG) return config;
  const agents = config.agents.filter((agent) => agent.id !== id);
  const defaultAgentId = config.defaultAgentId === id ? APP_SLUG : config.defaultAgentId;
  writeUserAgentsConfig(userName, { defaultAgentId, agents });
  return readUserAgentsConfig(userName);
}

export function updateUserAgentTelegram(userName: string, agentId: string, telegram: { chatId?: string }): KellixUserAgentsConfig {
  const config = readUserAgentsConfig(userName);
  const id = normalizeAgentId(agentId);
  const agents = config.agents.map((agent) => {
    if (agent.id !== id) return agent;
    const existing = agent.channels?.telegram || {};
    const nextTelegram = {
      ...existing,
      ...(telegram.chatId !== undefined ? { chatId: telegram.chatId.trim() } : {}),
    };
    return {
      ...agent,
      channels: {
        ...(agent.channels || {}),
        telegram: nextTelegram,
      },
    };
  });
  writeUserAgentsConfig(userName, { ...config, agents });
  return readUserAgentsConfig(userName);
}

export function findUserAgentByTelegramId(users: string[], telegramId: string | number): { userName: string; agentId: string } | null {
  const chatId = String(telegramId);
  for (const userName of users) {
    const config = readUserAgentsConfig(userName);
    for (const agent of config.agents) {
      if (agent.channels?.telegram?.chatId === chatId) {
        return { userName, agentId: agent.id };
      }
    }
  }
  return null;
}

export function listTelegramAgentRoutes(users: string[]): Array<{ userName: string; agentId: string; chatId?: string }> {
  const result: Array<{ userName: string; agentId: string; chatId?: string }> = [];
  for (const userName of users) {
    for (const agent of readUserAgentsConfig(userName).agents) {
      if (agent.channels?.telegram) result.push({ userName, agentId: agent.id, chatId: agent.channels.telegram.chatId });
    }
  }
  return result;
}
