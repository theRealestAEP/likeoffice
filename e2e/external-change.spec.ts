import { test, expect, _electron as electron } from "@playwright/test";
import { copyFile, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

/**
 * A file changed by another program must be reported, not clobbered.
 *
 * Edit a document in Word (or let a sync client pull a newer copy) while it is
 * open here, and the next save or autosave silently overwrote it with no
 * warning. The watcher deliberately watches the DIRECTORY: every one of these
 * programs saves by writing a temp file and renaming it over the original, and
 * a file watcher would go deaf after the first such swap.
 */
test("an outside edit raises a banner, and the app's own saves do not", async () => {
  test.setTimeout(180000);
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-ext-"));
  const docPath = path.join(dir, "shared.docx");
  await copyFile(path.join(APP_DIR, "resources/blank.docx"), docPath);

  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const app = await electron.launch({
    args: [APP_DIR, docPath],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData, LIKEOFFICE_FAKE_MODEL: "1", ANTHROPIC: "" },
  });
  try {
    const win = await app.firstWindow();
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
    // A short interval so the app's own writes definitely happen during the test.
    await win.evaluate(() => window.likeoffice.setSettings({ storage: { autosaveSeconds: 5 } }));
    await win.reload();
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });

    // THE APP'S OWN SAVES MUST BE SILENT. Type, let autosave write the file
    // several times, and no banner may appear — otherwise the warning is noise
    // and people learn to dismiss it.
    await win.locator(".dxw-page").first().click();
    await win.keyboard.type("Written here.");
    await expect(win.getByTestId("save-status")).toContainText(/Saved/, { timeout: 30000 });
    await win.waitForTimeout(7000);
    await expect(win.getByTestId("external-change")).toHaveCount(0);

    // Now somebody else writes the file, the way a real program does: temp
    // file, then an atomic rename over the original.
    const other = await readFile(path.join(APP_DIR, "resources/blank.docx"));
    const tmp = `${docPath}.other`;
    await writeFile(tmp, other);
    await rename(tmp, docPath);

    await expect(win.getByTestId("external-change")).toBeVisible({ timeout: 30000 });
    await expect(win.getByTestId("external-change")).toContainText("changed by another program");
    // Both outcomes are destructive, so both are offered rather than chosen.
    await expect(win.getByTestId("external-reload")).toBeVisible();
    await expect(win.getByTestId("external-keep")).toBeVisible();

    // Keeping this copy dismisses it and marks the document modified, so the
    // next save deliberately wins.
    await win.getByTestId("external-keep").click();
    await expect(win.getByTestId("external-change")).toHaveCount(0);
    await expect(win).toHaveTitle(/•/);
  } finally {
    app.process().kill("SIGKILL");
  }
});
