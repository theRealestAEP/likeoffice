import { test, expect, _electron as electron } from "@playwright/test";
import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

test("export the document as a PDF", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-"));
  const docPath = path.join(dir, "export.docx");
  const pdfPath = path.join(dir, "export.pdf");
  await copyFile(path.join(APP_DIR, "resources/blank.docx"), docPath);

  const app = await electron.launch({ args: [APP_DIR, docPath] });
  const win = await app.firstWindow();
  await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });

  await win.locator(".dxw-page").first().click();
  await win.keyboard.type("PDF export smoke test");

  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
  }, pdfPath);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send("menu", "export-pdf");
  });

  await expect.poll(() => existsSync(pdfPath), { timeout: 30000 }).toBe(true);
  const pdf = await readFile(pdfPath);
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  expect(pdf.length).toBeGreaterThan(1000);

  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await app.close();
});
