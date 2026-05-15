import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_SLUG } from "./brand.js";
import { getUserDir } from "./config.js";
import { toUserSlug } from "./users.js";

export interface KellixUserAgent {
  id: string;
  name: string;
  goal: string;
  default?: boolean;
  createdAt?: string;
  channels?: {
    telegram?: {
      chatId?: string;
    };
  };
}

export interface KellixUserAgentsConfig {
  defaultAgentId: string;
  agents: KellixUserAgent[];
}

const USER_AGENTS_FILE = "agents.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeAgentId(value: string): string {
  return toUserSlug(value).replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "") || APP_SLUG;
}

export function getUserAgentsPath(userName: string): string {
  return join(getUserDir(userName), USER_AGENTS_FILE);
}

export function getDefaultKellixAgent(): KellixUserAgent {
  return {
    id: APP_SLUG,
    name: "Kellix",
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
      agents: agents.map((agent) => ({ ...agent, default: agent.id === defaultAgentId })),
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
  writeFileSync(
    getUserAgentsPath(userName),
    `${JSON.stringify({
      defaultAgentId,
      agents: agents.map((agent) => ({ ...agent, default: agent.id === defaultAgentId })),
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
    goal: agent.goal.trim(),
    default: agent.default === true,
    createdAt: agent.createdAt || config.agents.find((entry) => entry.id === id)?.createdAt || new Date().toISOString(),
    channels: agent.channels,
  };
  const agents = config.agents.filter((entry) => entry.id !== id).concat(next);
  const defaultAgentId = next.default ? id : config.defaultAgentId;
  const nextConfig = { defaultAgentId, agents };
  writeUserAgentsConfig(userName, nextConfig);
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
