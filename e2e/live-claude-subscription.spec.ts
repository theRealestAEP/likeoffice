import { test, expect, _electron as electron } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

// A live smoke against the user's Claude Code login. It spends real usage, so
// it only runs when explicitly requested:
//   LIKEOFFICE_LIVE_SMOKE=1 npx playwright test e2e/live-claude-subscription.spec.ts
test.skip(!process.env.LIKEOFFICE_LIVE_SMOKE, "live smoke only runs with LIKEOFFICE_LIVE_SMOKE=1");

test("a claude-subscription session lands a tracked change via the MCP bridge", async () => {
  test.setTimeout(300000);
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-"));
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const docPath = path.join(dir, "smoke.docx");
  await copyFile(path.join(APP_DIR, "resources/blank.docx"), docPath);
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify({ provider: "claude-subscription", apiKey: "", model: "claude-sonnet-5" }),
  );

  const app = await electron.launch({
    args: [APP_DIR, docPath],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData, ANTHROPIC: "" },
  });
  const win = await app.firstWindow();
  await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });

  await win.locator(".dxw-page").first().click();
  await win.keyboard.type("Hello world");
  await expect(win.locator(".dxw-page").first()).toContainText("Hello world");

  await win.getByTestId("ai-toggle").click();
  await win.getByTestId("ai-input").fill("Replace Hello with Goodbye");
  await win.getByTestId("ai-input").press("Enter");

  await expect(win.getByTestId("ai-suggested")).toContainText("suggested change", {
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
  expect(xml).toContain("Goodbye");
  expect(xml).toMatch(/<w:(ins|del) [^>]*w:author="AI"/);

  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await app.close();
});
