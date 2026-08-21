import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

/**
 * A link in a document must never open a renderer inside this app.
 *
 * With no window-open handler Electron answers `window.open` by building a
 * second BrowserWindow and loading the remote page in it. The href comes out of
 * the .docx, so that page is chosen by whoever wrote the document, and context
 * isolation is then the only thing between it and the preload bridge — the
 * barrier CVE-2026-70601 defeats. This asserts the app opens no such window.
 */
test("a document's link opens outside the app, not in a new renderer", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-winopen-"));
  const app = await electron.launch({
    args: [APP_DIR],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData, LIKEOFFICE_FAKE_MODEL: "1", ANTHROPIC: "" },
  });
  try {
    const win = await app.firstWindow();
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });

    // Count the app's own windows, and record what shell.openExternal is asked
    // for instead of actually launching a browser during the test.
    const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    await app.evaluate(({ shell }) => {
      (globalThis as unknown as { __opened: string[] }).__opened = [];
      shell.openExternal = async (url: string) => {
        (globalThis as unknown as { __opened: string[] }).__opened.push(url);
      };
    });

    await win.evaluate(() => { window.open("https://example.com/", "_blank", "noopener,noreferrer"); });
    await win.waitForTimeout(1500);

    const urls = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()));
    expect(urls.filter((u) => u.startsWith("http"))).toEqual([]);
    expect(urls).toHaveLength(before);

    const opened = await app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);
    expect(opened).toEqual(["https://example.com/"]);
  } finally {
    await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.destroy(); });
    await app.close();
  }
});
