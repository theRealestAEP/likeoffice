import { test, expect, _electron as electron } from "@playwright/test";
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

async function launchWithDoc() {
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-wc-"));
  const docPath = path.join(dir, "wordcount.docx");
  await copyFile(path.join(APP_DIR, "resources/blank.docx"), docPath);
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const app = await electron.launch({
    args: [APP_DIR, docPath],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData },
  });
  const win = await app.firstWindow();
  await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
  return { app, win };
}

async function closeApp(app: Awaited<ReturnType<typeof launchWithDoc>>["app"]) {
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await app.close();
}

test("live word count with detail popover (fallback path: this engine build has no wordCount API)", async () => {
  const { app, win } = await launchWithDoc();
  const counter = win.locator('[data-testid="word-count"]');

  await expect(counter).toHaveText("0 words", { timeout: 15000 });

  // Feature-detect precondition: the engine api does NOT carry wordCount()
  // yet, so everything this test sees comes from the app-side fallback.
  const hasEngineCount = await win.evaluate(
    () =>
      typeof (window as unknown as { __likeofficeApi: { wordCount?: unknown } }).__likeofficeApi
        .wordCount === "function",
  );
  expect(hasEngineCount).toBe(false);

  await win.locator(".dxw-page").first().click();
  await win.keyboard.type("one two three");
  await expect(counter).toHaveText("3 words", { timeout: 15000 });

  // The popover breaks the count down.
  await counter.click();
  const popover = win.locator('[data-testid="word-count-popover"]');
  await expect(popover).toBeVisible();
  const rows = await popover.locator(".word-count-row").allTextContents();
  expect(rows).toEqual(["Pages1", "Words3", "Characters13", "Paragraphs1"]);
  await counter.click();
  await expect(popover).toHaveCount(0);

  await closeApp(app);
});

test("the engine's wordCount() is preferred when present (feature detect)", async () => {
  const { app, win } = await launchWithDoc();
  const counter = win.locator('[data-testid="word-count"]');
  await expect(counter).toHaveText("0 words", { timeout: 15000 });

  // Simulate the engine API landing: patch wordCount onto the live api.
  await win.evaluate(() => {
    (
      window as unknown as { __likeofficeApi: { wordCount?: () => number } }
    ).__likeofficeApi.wordCount = () => 4242;
  });
  await win.locator(".dxw-page").first().click();
  await win.keyboard.type("trigger");
  await expect(counter).toHaveText("4,242 words", { timeout: 15000 });

  await closeApp(app);
});
