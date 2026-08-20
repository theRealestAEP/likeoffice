import { test, expect, _electron as electron } from "@playwright/test";
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

/**
 * The Home tab's font and size boxes REPORT, and a caret is enough.
 *
 * They used to fill in only for a range selection: clicking into a paragraph
 * left them reading "Font" and "Size", so the app could not name the font it
 * was about to type in. The value shown is the EFFECTIVE one, resolved through
 * the style chain — a blank document's runs carry no direct rPr at all, so
 * reading their own props would still show nothing.
 */
test("the font and size boxes name the formatting at the caret", async () => {
  test.setTimeout(120000);
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-font-"));
  const docPath = path.join(dir, "font.docx");
  await copyFile(path.join(APP_DIR, "resources/blank.docx"), docPath);

  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const app = await electron.launch({
    args: [APP_DIR, docPath],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData },
  });
  try {
    const win = await app.firstWindow();
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
    const font = win.locator('[data-tip="Font"]');
    const size = win.locator('[data-tip="Font size"]');

    // A caret alone, in an empty paragraph: blank.docx is Aptos 11.
    await win.locator(".dxw-page").first().click();
    await expect(font).toHaveText(/Aptos/);
    await expect(size).toHaveText(/11/);

    // …and typing does not lose it.
    await win.keyboard.type("Hello");
    await expect(font).toHaveText(/Aptos/);
    await expect(size).toHaveText(/11/);
  } finally {
    // See watermark.spec.ts: a graceful close hangs in this harness.
    app.process().kill("SIGKILL");
  }
});
