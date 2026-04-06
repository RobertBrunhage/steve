import { getBrowserSettings } from "../config.js";

export interface BrowserCompanionStatus {
  available: boolean;
  running: boolean;
  message: string;
}

export async function getBrowserCompanionStatus(): Promise<BrowserCompanionStatus> {
  const settings = getBrowserSettings();
  if (!settings.remoteEnabled || !settings.remoteBaseUrl) {
    return {
      available: false,
      running: false,
      message: "The remote browser companion is not configured for this install yet.",
    };
  }

  try {
    const res = await fetch(`${settings.remoteBaseUrl.replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) {
      return {
        available: true,
        running: false,
        message: `The remote browser companion is configured but returned HTTP ${res.status}.`,
      };
    }
    return {
      available: true,
      running: true,
      message: "The remote browser companion is running and ready for attached Chrome sessions.",
    };
  } catch {
    return {
      available: true,
      running: false,
      message: "The remote browser companion is configured but not running right now.",
    };
  }
}
