import { getRuntime } from "./config.js";

export interface HealthStatus {
  healthy: boolean;
  uptime: number;
  components: {
    opencode: Record<string, { status: "ok" | "error"; message?: string }>;
    telegram: { status: "ok" | "error" | "not_configured"; message?: string };
    vault: { status: "ok" | "not_configured"; secrets: number };
    scheduler: { status: "ok"; reminders: number };
  };
}

const startTime = Date.now();
let reminderCount = 0;
let telegramConnected = false;
let vaultSecretCount = 0;

export function setReminderCount(count: number) { reminderCount = count; }
export function setTelegramConnected(connected: boolean) { telegramConnected = connected; }
export function setVaultSecretCount(count: number) { vaultSecretCount = count; }

async function checkOpenCode(userName: string): Promise<{ status: "ok" | "error"; message?: string }> {
  const url = `http://opencode-${userName.toLowerCase()}:3456`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok ? { status: "ok" } : { status: "error", message: `HTTP ${res.status}` };
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : "unreachable" };
  }
}

export async function getHealth(): Promise<HealthStatus> {
  // Check OpenCode per-user
  const opencode: Record<string, { status: "ok" | "error"; message?: string }> = {};
  try {
    const rt = getRuntime();
    const userNames = [...new Set(Object.values(rt.users))];
    await Promise.all(userNames.map(async (name) => {
      opencode[name.toLowerCase()] = await checkOpenCode(name);
    }));
  } catch {
    opencode["default"] = { status: "error", message: "runtime not initialized" };
  }

  let hasBotToken = false;
  try { hasBotToken = !!getRuntime().botToken; } catch {}
  const telegram: HealthStatus["components"]["telegram"] = hasBotToken
    ? { status: telegramConnected ? "ok" : "error", message: telegramConnected ? undefined : "not connected" }
    : { status: "not_configured" };

  const vault: HealthStatus["components"]["vault"] = vaultSecretCount > 0
    ? { status: "ok", secrets: vaultSecretCount }
    : { status: "not_configured", secrets: 0 };

  const scheduler: HealthStatus["components"]["scheduler"] = { status: "ok", reminders: reminderCount };

  const allOcOk = Object.values(opencode).every((o) => o.status === "ok");
  const healthy = allOcOk && telegram.status === "ok";

  return {
    healthy,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    components: { opencode, telegram, vault, scheduler },
  };
}
