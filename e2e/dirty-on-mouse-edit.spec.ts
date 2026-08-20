import { test, expect, _electron as electron } from "@playwright/test";
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

/**
 * An edit that touches no key must still mark the document modified.
 *
 * The dirty flag used to be a DOM heuristic — keydown, paste, cut, drop and a
 * toolbar mousedown. An image dragged or resized with the mouse fires none of
 * those, so the document stayed "clean": closing the window offered no save
 * prompt AND deleted the recovery copy, losing the edit outright.
 *
 * It is now driven by the intent stream, which every edit passes through
 * whatever gesture made it. This drives an object edit through the api rather
 * than synthesising a drag, because the assertion is about the SIGNAL, not
 * about pointer emulation.
 */
test("an edit made without the keyboard still marks the document dirty", async () => {
  test.setTimeout(180000);
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-dirty-"));
  const docPath = path.join(dir, "dirty.docx");
  await copyFile(path.join(APP_DIR, "resources/blank.docx"), docPath);

  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const app = await electron.launch({
    args: [APP_DIR, docPath],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData, LIKEOFFICE_FAKE_MODEL: "1", ANTHROPIC: "" },
  });
  try {
    const win = await app.firstWindow();
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
    await win.evaluate(() => window.likeoffice.setSettings({ storage: { autosave: false } }));

    // Clean to begin with.
    await expect(win).not.toHaveTitle(/•/);

    // A structural edit with no keystroke anywhere: the same route a mouse
    // drag or a toolbar object command takes.
    await win.locator(".dxw-page").first().click();
    await win.evaluate(() => {
      const api = (window as unknown as { __likeofficeApi: { insertTable(r: number, c: number): void } })
        .__likeofficeApi;
      api.insertTable(2, 2);
    });

    await expect(win).toHaveTitle(/•/);
    await expect(win.getByTestId("save-status")).toContainText("Unsaved changes");
  } finally {
    app.process().kill("SIGKILL");
  }
});
