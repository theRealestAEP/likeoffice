import { test, expect, _electron as electron } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

// A live smoke against the Messages API, on the key the app reads from .env.
// It spends real tokens, so it only runs when explicitly requested:
//   LIKEOFFICE_LIVE_SMOKE=1 npx playwright test e2e/live-api-format.spec.ts
test.skip(!process.env.LIKEOFFICE_LIVE_SMOKE, "live smoke only runs with LIKEOFFICE_LIVE_SMOKE=1");

/**
 * The fake model proves the panel injects `suggest` into the operation it is
 * handed. This proves the same thing about an operation a real model wrote:
 * the shape it chose for a formatting ask still comes back through
 * withSuggestions and still reaches the file as a tracked property change.
 */
test("a live model's formatting change is recorded as a tracked revision", async () => {
  test.setTimeout(300000);
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-"));
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const docPath = path.join(dir, "live-format.docx");
  await copyFile(path.join(APP_DIR, "resources/blank.docx"), docPath);
  // No key here: the app reads ANTHROPIC / ANTHROPIC_API_KEY from the
  // environment or the repo's .env, so no key is written to disk by this test.
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify({ provider: "anthropic-api", model: "claude-opus-5" }),
  );

  const app = await electron.launch({
    args: [APP_DIR, docPath],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData },
  });
  const win = await app.firstWindow();
  await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });

  await win.locator(".dxw-page").first().click();
  await win.keyboard.type("Hello world");
  await expect(win.locator(".dxw-page").first()).toContainText("Hello world");

  await win.getByTestId("ai-toggle").click();
  await win.getByTestId("ai-input").fill("Make the first paragraph bold");
  await win.getByTestId("ai-input").press("Enter");
  await expect(win.getByTestId("ai-suggested")).toContainText("1 suggested change", {
    timeout: 240000,
  });

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send("menu", "save");
  });
  await expect(win).not.toHaveTitle(/•/, { timeout: 15000 });

  const xml = execFileSync("unzip", ["-p", docPath, "word/document.xml"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  expect(xml).toContain("Hello world");
  expect(xml).toContain("<w:b/>");
  expect(xml).toMatch(/<w:rPrChange [^>]*w:author="AI"/);

  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await app.close();
});
