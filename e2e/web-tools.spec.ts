import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";

const APP_DIR = path.join(__dirname, "../apps/desktop");

/**
 * The agent's web tools, against a LOCAL server standing in for the internet.
 *
 * A real search engine or website would make this test a network weather
 * report. A server in-process gives the same two code paths — a SearXNG JSON
 * response and an HTML page — with none of the flakiness, and it also lets the
 * SearXNG-answered-HTML case be provoked on purpose, which is the failure a
 * user with a default SearXNG install actually hits.
 */
function startFakeInternet(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/search" && url.searchParams.get("format") === "json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          results: [
            { title: "Hedgehog facts", url: "http://example.test/hedgehog", content: "They are nocturnal." },
            { title: "More hedgehogs", url: "http://example.test/more", content: "They hibernate." },
          ],
        }),
      );
      return;
    }
    // A SearXNG with JSON disabled answers the same URL with a web page.
    if (url.pathname === "/nojson/search") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>search page</body></html>");
      return;
    }
    if (url.pathname === "/ddg") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body>
        <div class="result results_links">
          <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.test%2Fone&amp;rut=x">First &amp; best</a>
          <a class="result__snippet">A snippet.</a>
        </div>
        <div class="result results_links">
          <a class="result__a" href="https://example.test/two">Second</a>
          <a class="result__snippet">Another snippet.</a>
        </div>
      </body></html>`);
      return;
    }
    if (url.pathname === "/ddg-changed") {
      // The markup moved on. The reader must return NOTHING, not guesses.
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<html><body><div class="serp__result"><a class="x" href="/a">t</a></div></body></html>`);
      return;
    }
    if (url.pathname === "/article") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<html><head><title>Hedgehogs &amp; you</title><style>.x{color:red}</style></head>
         <body><script>console.log("ignore me")</script>
         <h1>Hedgehogs</h1><p>They are   nocturnal.</p><p>They hibernate &lt;mostly&gt;.</p></body></html>`,
      );
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("nope");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

test("the agent's web tools search and read, and say why when they cannot", async () => {
  test.setTimeout(180000);
  const net = await startFakeInternet();
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-web-"));
  const app = await electron.launch({
    args: [APP_DIR],
    env: {
      ...process.env,
      LIKEOFFICE_USER_DATA: userData,
      LIKEOFFICE_FAKE_MODEL: "1",
      ANTHROPIC: "",
      // The stand-in internet lives on 127.0.0.1, which web_fetch refuses by
      // design; see assertPublicHost.
      LIKEOFFICE_ALLOW_PRIVATE_FETCH: "1",
    },
  });
  try {
    const win = await app.firstWindow();
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });

    // Point search at the stand-in, the way the settings page would.
    await win.evaluate(
      (origin) => window.likeoffice.setSettings({ web: { backend: "searxng", searxngUrl: origin } }),
      net.origin,
    );

    const found = await win.evaluate(() => window.likeoffice.webSearch("hedgehogs"));
    expect("results" in found && found.results.length).toBe(2);
    expect("results" in found && found.results[0]).toMatchObject({
      title: "Hedgehog facts",
      url: "http://example.test/hedgehog",
    });

    // Reading a page: markup, script and style come out; entities decode.
    const page = await win.evaluate(
      (origin) => window.likeoffice.webFetch(`${origin}/article`),
      net.origin,
    );
    expect("text" in page).toBe(true);
    if ("text" in page) {
      expect(page.title).toBe("Hedgehogs & you");
      expect(page.text).toContain("They are nocturnal.");
      expect(page.text).toContain("They hibernate <mostly>.");
      expect(page.text).not.toContain("ignore me");
      expect(page.text).not.toContain("color:red");
      expect(page.truncated).toBe(false);
    }

    // A SearXNG with JSON turned off is the common misconfiguration, so the
    // error has to name the fix rather than report a parse failure.
    await win.evaluate(
      (origin) => window.likeoffice.setSettings({ web: { searxngUrl: `${origin}/nojson` } }),
      net.origin,
    );
    const misconfigured = await win.evaluate(() => window.likeoffice.webSearch("hedgehogs"));
    expect("error" in misconfigured && misconfigured.error).toContain("settings.yml");

    // Only http(s): a file:// fetch would turn a web tool into a disk reader.
    const local = await win.evaluate(() => window.likeoffice.webFetch("file:///etc/passwd"));
    expect("error" in local && local.error).toContain("http");

    // A hosted backend with no key says so instead of failing at the network.
    await win.evaluate(() => window.likeoffice.setSettings({ web: { backend: "brave" } }));
    const keyless = await win.evaluate(() => window.likeoffice.webSearch("hedgehogs"));
    expect("error" in keyless && keyless.error).toContain("No API key");
  } finally {
    await app.close();
    await net.close();
  }
});

/**
 * The direct reader, which is the DEFAULT and the only backend that needs
 * nothing set up. Pointed at a local stand-in for DuckDuckGo's HTML endpoint so
 * the assertions are about the parser, not about the internet.
 */
test("direct search unwraps redirects and degrades to nothing when the markup moves", async () => {
  test.setTimeout(120000);
  const net = await startFakeInternet();
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-ddg-"));
  const app = await electron.launch({
    args: [APP_DIR],
    env: {
      ...process.env,
      LIKEOFFICE_USER_DATA: userData,
      LIKEOFFICE_FAKE_MODEL: "1",
      ANTHROPIC: "",
      // The endpoint is an env override so this can run offline; see web-tools.ts.
      LIKEOFFICE_DDG_ENDPOINT: `${net.origin}/ddg`,
    },
  });
  try {
    const win = await app.firstWindow();
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
    // "direct" is the default, so nothing is configured here on purpose.
    const found = await win.evaluate(() => window.likeoffice.webSearch("hedgehogs"));
    expect("results" in found).toBe(true);
    if ("results" in found) {
      expect(found.results).toHaveLength(2);
      // The redirect wrapper is unwrapped, and the entity in the title decodes.
      expect(found.results[0].url).toBe("https://example.test/one");
      expect(found.results[0].title).toBe("First & best");
      expect(found.results[0].snippet).toBe("A snippet.");
      expect(found.results[1].url).toBe("https://example.test/two");
    }
  } finally {
    await app.close();
    await net.close();
  }
});

test("a changed result markup yields no results rather than wrong ones", async () => {
  test.setTimeout(120000);
  const net = await startFakeInternet();
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-ddg2-"));
  const app = await electron.launch({
    args: [APP_DIR],
    env: {
      ...process.env,
      LIKEOFFICE_USER_DATA: userData,
      LIKEOFFICE_FAKE_MODEL: "1",
      ANTHROPIC: "",
      LIKEOFFICE_DDG_ENDPOINT: `${net.origin}/ddg-changed`,
    },
  });
  try {
    const win = await app.firstWindow();
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
    const found = await win.evaluate(() => window.likeoffice.webSearch("hedgehogs"));
    expect("results" in found && found.results).toEqual([]);
  } finally {
    await app.close();
    await net.close();
  }
});

/**
 * web_fetch must not reach the machine or its LAN.
 *
 * The URL is chosen by the MODEL, and the model reads documents and web pages
 * that may contain instructions. Without this, text hidden in a document could
 * steer it into fetching http://localhost:8080 or a router's admin page and
 * handing the response back. Run WITHOUT the test seam, so the real rule applies.
 */
test("web_fetch refuses the local machine and private networks", async () => {
  test.setTimeout(120000);
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-ssrf-"));
  const app = await electron.launch({
    args: [APP_DIR],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData, LIKEOFFICE_FAKE_MODEL: "1", ANTHROPIC: "" },
  });
  try {
    const win = await app.firstWindow();
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
    for (const url of [
      "http://127.0.0.1:8080/",
      "http://localhost:3000/admin",
      "http://192.168.1.1/",
      "http://10.0.0.5/",
      "http://169.254.169.254/latest/meta-data/", // cloud instance metadata
      "http://[::1]:9000/",
    ]) {
      const result = await win.evaluate((u) => window.likeoffice.webFetch(u), url);
      expect("error" in result, `${url} should be refused`).toBe(true);
      if ("error" in result) expect(result.error).toContain("not a public address");
    }
  } finally {
    await app.close();
  }
});
