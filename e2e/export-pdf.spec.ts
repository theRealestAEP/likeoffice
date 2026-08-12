import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";

const APP_DIR = path.join(__dirname, "../apps/desktop");

async function openBlankDocument() {
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-"));
  // Own userData per run: a shared one carries autosave files from earlier
  // runs, and each of those opens a recovery window BEFORE the document
  // window. The test would then type into the recovery window and export the
  // still-blank document window.
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const docPath = path.join(dir, "export.docx");
  const pdfPath = path.join(dir, "export.pdf");
  await copyFile(path.join(APP_DIR, "resources/blank.docx"), docPath);

  const app = await electron.launch({
    args: [APP_DIR, docPath],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData },
  });
  const win = await app.firstWindow();
  await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
  await expect(win).toHaveTitle(/export\.docx/);
  await win.locator(".dxw-page").first().click();
  return { app, win, pdfPath };
}

async function exportPdf(app: ElectronApplication, pdfPath: string): Promise<string[]> {
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
  }, pdfPath);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send("menu", "export-pdf");
  });
  await expect.poll(() => existsSync(pdfPath), { timeout: 30000 }).toBe(true);

  const bytes = await readFile(pdfPath);
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  // Page text, in page order. A byte count says nothing about what the PDF
  // paints — an empty page still weighs ~1 kB.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  return text;
}

async function closeApp(app: ElectronApplication): Promise<void> {
  // Destroy rather than close: the document is dirty, and closing it would
  // block on the native save dialog. Destroying the LAST window makes the app
  // quit, which kills this very evaluate's reply — the process is gone before
  // the promise resolves. That is the intended outcome, so neither call's
  // rejection means anything about the test.
  await app
    .evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.destroy();
    })
    .catch(() => {});
  await app.close().catch(() => {});
}

test("export the document as a PDF", async () => {
  const { app, win, pdfPath } = await openBlankDocument();
  await win.keyboard.type("PDF export smoke test");

  const pages = await exportPdf(app, pdfPath);
  expect(pages).toHaveLength(1);
  expect(pages[0]).toContain("PDF export smoke test");

  await closeApp(app);
});

test("export a multi-page document as a PDF", async () => {
  const { app, win, pdfPath } = await openBlankDocument();
  await win.keyboard.type("First page marker");
  // Enough empty paragraphs to push the next line onto page two.
  for (let i = 0; i < 60; i++) await win.keyboard.press("Enter");
  await win.keyboard.type("Last page marker");
  await expect(win.locator(".dxw-page")).toHaveCount(2, { timeout: 15000 });

  const pages = await exportPdf(app, pdfPath);
  expect(pages).toHaveLength(2);
  expect(pages[0]).toContain("First page marker");
  expect(pages[1]).toContain("Last page marker");

  await closeApp(app);
});
