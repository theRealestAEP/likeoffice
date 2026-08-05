import { test, expect, _electron as electron } from "@playwright/test";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

test("recover an autosaved document after a crash", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const autosaveFile = path.join(userData, "autosave", "1000-1.docx");
  await mkdir(path.dirname(autosaveFile), { recursive: true });
  await copyFile(path.join(APP_DIR, "resources/blank.docx"), autosaveFile);
  await writeFile(
    `${autosaveFile}.json`,
    JSON.stringify({ originalPath: null, savedAt: new Date().toISOString() }),
  );

  const app = await electron.launch({
    args: [APP_DIR],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData },
  });
  const win = await app.firstWindow();

  await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
  await expect(win).toHaveTitle(/• Untitled/);

  // Destroy directly: a dirty window's close handler opens a native save
  // dialog that would block the test.
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await app.close();
});
