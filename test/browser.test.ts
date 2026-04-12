import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function main() {
  const tempDir = mkdtempSync(join(tmpdir(), "kellix-browser-remote-test-"));
  const port = 47899;
  let lastBody: Record<string, unknown> | null = null;

  process.env.KELLIX_DIR = tempDir;
  process.env.KELLIX_REMOTE_BROWSER_URL = `http://127.0.0.1:${port}`;

  const server = createServer(async (req, res) => {
    const body = await new Promise<string>((resolve) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk.toString(); });
      req.on("end", () => resolve(data));
    });
    lastBody = body ? JSON.parse(body) : {};
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      status: "ok",
      url: typeof lastBody?.url === "string" ? lastBody.url : "https://example.com",
      title: "Attached Chrome",
      text: "Signed in successfully",
      elements: [{ ref: "uid=1", role: "button", name: "Continue" }],
      message: "Opened in attached Chrome",
    }));
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));

  try {
    const { PlaywrightBrowserService } = await import(`../src/browser/service.ts?${Date.now()}`);
    const { getPreferredBrowserTarget } = await import(`../src/browser/preferences.ts?${Date.now()}`);
    const { writeAttachedBrowserConfig } = await import(`../src/browser/attachments.ts?${Date.now()}`);

    const service = new PlaywrightBrowserService();
    writeAttachedBrowserConfig("robert", { channel: "stable" });

    const openResult = await service.open({ userName: "robert", url: "https://accounts.google.com", target: "remote" });
    const attach = lastBody ? (lastBody["attach"] as { mode?: string; channel?: string }) : null;
    assert.equal(openResult.ok, true);
    assert.equal(openResult.title, "Attached Chrome");
    assert.equal(attach?.mode, "local_chrome");
    assert.equal(attach?.channel, "stable");
    assert.equal(getPreferredBrowserTarget("robert", "accounts.google.com"), "remote");

    const snapshotResult = await service.snapshot({ userName: "robert", target: "remote" });
    assert.equal(snapshotResult.ok, true);
    assert.equal(snapshotResult.title, "Attached Chrome");

    const noAttachResult = await service.open({ userName: "friend", url: "https://amazon.com", target: "remote" });
    assert.equal(noAttachResult.ok, false);
    assert.equal(noAttachResult.error, "remote_not_configured");

    console.log("Browser remote tests passed");
  } finally {
    server.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
