import { test, expect, _electron as electron } from "@playwright/test";
import { copyFile, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

test("open, edit, and save a document", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-"));
  const docPath = path.join(dir, "smoke.docx");
  await copyFile(path.join(APP_DIR, "resources/blank.docx"), docPath);
  const before = await stat(docPath);

  const app = await electron.launch({ args: [APP_DIR, docPath] });
  const win = await app.firstWindow();

  await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
  await expect(win).toHaveTitle(/smoke\.docx/);

  await win.locator(".dxw-page").first().click();
  await win.keyboard.type("Hello from LikeOffice");
  await expect(win).toHaveTitle(/•/);

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send("menu", "save");
  });
  await expect(win).not.toHaveTitle(/•/, { timeout: 15000 });

  const after = await stat(docPath);
  expect(after.size).not.toBe(before.size);

  await app.close();
});
