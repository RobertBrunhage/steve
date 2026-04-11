import { PlaywrightBrowserService } from "./service.js";

let browserService: PlaywrightBrowserService | null = null;

export function getBrowserService(): PlaywrightBrowserService {
  if (!browserService) {
    browserService = new PlaywrightBrowserService();
  }
  return browserService;
}
