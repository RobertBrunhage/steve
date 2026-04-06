import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import {
  CookieJar,
  cleanupTestEnv,
  createTestEnv,
  downLocalStack,
  extractCsrf,
  requestText,
  runCommand,
  sleep,
  startTelegramMockServer,
  waitFor,
} from "./helpers.js";

async function callBrowserApi(testEnv: ReturnType<typeof createTestEnv>, jar: CookieJar, path: string, body: Record<string, unknown>) {
  const res = await fetch(`http://127.0.0.1:${testEnv.webPort}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: jar.header() },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  return res.json();
}

async function login(testEnv: ReturnType<typeof createTestEnv>, jar: CookieJar) {
  const loginPage = await requestText(`http://127.0.0.1:${testEnv.webPort}/login`, { jar });
  if (loginPage.res.status === 302) {
    return;
  }
  assert.equal(loginPage.res.status, 200);
  const loginPost = await requestText(`http://127.0.0.1:${testEnv.webPort}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: "browser-pass-123" }),
    jar,
  });
  assert.equal(loginPost.res.status, 302);
}

async function startFixtureServer(port: number) {
  const server = createServer((req, res) => {
    if (req.url === "/login" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html><html><body>
        <h1>Sign in</h1>
        <form action="/login" method="post">
          <label>Email <input aria-label="Email" name="email" type="text"></label>
          <label>Password <input aria-label="Password" name="password" type="password"></label>
          <button type="submit">Sign in</button>
        </form>
      </body></html>`);
      return;
    }

    if (req.url === "/login" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", () => {
        const params = new URLSearchParams(body);
        const ok = params.get("email") === "robert@example.com" && params.get("password") === "secret123";
        if (!ok) {
          res.writeHead(401, { "Content-Type": "text/html" });
          res.end("<html><body>Sign in failed</body></html>");
          return;
        }
        res.writeHead(302, {
          Location: "/dashboard",
          "Set-Cookie": "session=ok; Path=/",
        });
        res.end();
      });
      return;
    }

    if (req.url === "/dashboard") {
      const cookie = req.headers.cookie || "";
      if (!cookie.includes("session=ok")) {
        res.writeHead(302, { Location: "/login" });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html><html><body>
        <h1>Dashboard</h1>
        <p>Welcome Robert</p>
        <a href="/download/report.txt">Download report</a>
      </body></html>`);
      return;
    }

    if (req.url === "/download/report.txt") {
      res.writeHead(200, {
        "Content-Type": "text/plain",
        "Content-Disposition": 'attachment; filename="report.txt"',
      });
      res.end("browser report\n");
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
  return server;
}

async function main() {
  const cwd = process.cwd();
  const testEnv = createTestEnv(cwd, "browser-flow");
  const telegram = await startTelegramMockServer(testEnv.telegramPort, testEnv.telegramToken);
  const fixturePort = testEnv.telegramPort + 1;
  const fixture = await startFixtureServer(fixturePort);
  const jar = new CookieJar();

  try {
    await runCommand("./steve", ["up"], { cwd, env: testEnv.env, timeoutMs: 600000 });
    await waitFor(`http://127.0.0.1:${testEnv.webPort}/setup`);

    const setupUrlResult = await runCommand("./steve", ["setup-url"], {
      cwd,
      env: testEnv.env,
      capture: true,
      timeoutMs: 30000,
    });
    assert.equal(setupUrlResult.code, 0);
    const setupUrlMatch = setupUrlResult.stdout.match(/http:\/\/[^\s]+/);
    if (!setupUrlMatch) throw new Error("Expected setup URL");
    const setupUrl = new URL(setupUrlMatch[0]);
    setupUrl.hostname = "127.0.0.1";
    const setupPage = await requestText(setupUrl.toString(), { jar });
    const setupCsrf = extractCsrf(setupPage.text);
    const setupPost = await requestText(`http://127.0.0.1:${testEnv.webPort}/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: setupCsrf,
        password: "browser-pass-123",
        confirm_password: "browser-pass-123",
        timezone: "Europe/Stockholm",
        bot_token: testEnv.telegramToken,
        user_name_0: "Robert",
      }),
      jar,
    });
    assert.equal(setupPost.res.status, 200);

    await login(testEnv, jar);

    const openRes = await callBrowserApi(testEnv, jar, "/api/browser/open", { userName: "robert", url: `http://host.docker.internal:${fixturePort}/login` });
    assert.equal(openRes.status, "auth_required", JSON.stringify(openRes));
    assert.ok(openRes.viewerUrl);
    const viewer = await fetch(openRes.viewerUrl);
    assert.equal(viewer.ok, true);

    const snapshotRes = await callBrowserApi(testEnv, jar, "/api/browser/snapshot", { userName: "robert" });
    const emailRef = snapshotRes.elements.find((element: any) => /email/i.test(element.name))?.ref;
    const passwordRef = snapshotRes.elements.find((element: any) => /password/i.test(element.name))?.ref;
    const submitRef = snapshotRes.elements.find((element: any) => /sign in/i.test(element.name))?.ref;
    assert.ok(emailRef && passwordRef && submitRef);

    await callBrowserApi(testEnv, jar, "/api/browser/type", { userName: "robert", ref: emailRef, text: "robert@example.com" });
    await callBrowserApi(testEnv, jar, "/api/browser/type", { userName: "robert", ref: passwordRef, text: "secret123" });
    const clickRes = await callBrowserApi(testEnv, jar, "/api/browser/click", { userName: "robert", ref: submitRef });
    assert.equal(clickRes.status, "ok");
    assert.match(clickRes.url, /\/dashboard$/);

    const shot = await callBrowserApi(testEnv, jar, "/api/browser/screenshot", { userName: "robert" });
    assert.ok(shot.screenshotPath);
    const shotExists = await runCommand("docker", ["exec", `${testEnv.project}-steve-1`, "test", "-f", shot.screenshotPath], {
      cwd,
      env: testEnv.env,
      capture: true,
      timeoutMs: 30000,
    });
    assert.equal(shotExists.code, 0);

    const downloadSnapshot = await callBrowserApi(testEnv, jar, "/api/browser/snapshot", { userName: "robert" });
    const downloadRef = downloadSnapshot.elements.find((element: any) => /download report/i.test(element.name))?.ref;
    assert.ok(downloadRef);
    const downloadRes = await callBrowserApi(testEnv, jar, "/api/browser/download", { userName: "robert", ref: downloadRef });
    assert.match(downloadRes.downloadPath, /report\.txt$/);

    console.log("E2E browser flow passed");
  } finally {
    fixture.close();
    await telegram.close();
    await downLocalStack(cwd, testEnv);
    cleanupTestEnv(testEnv);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
