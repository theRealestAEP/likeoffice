import { test, expect, _electron as electron } from "@playwright/test";
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");
/** Any real raster will do; the app ships this one. */
const PICTURE = path.join(APP_DIR, "build/icon.png");

/**
 * The Insert tab in the REAL app, which routes every edit through the collab
 * intent path (LocalDocumentSession). The engine's own unit tests cover the
 * watermark markup; what only this bed can show is that the operation survives
 * that route — the bytes reach the media part instead of staying pending, and
 * the picture actually paints on the page.
 *
 * One launch for both checks: starting Electron dominates the runtime, and
 * neither check disturbs the other.
 */
test("the Insert tab reads in full and stamps a picture watermark", async () => {
  test.setTimeout(180000);
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-wm-"));
  const docPath = path.join(dir, "watermark.docx");
  await copyFile(path.join(APP_DIR, "resources/blank.docx"), docPath);

  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const app = await electron.launch({
    args: [APP_DIR, docPath],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData },
  });
  try {
    const win = await app.firstWindow();
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
    // Room for the whole tab. The ribbon's layout engine folds controls it
    // cannot fit and offers them behind a chevron, so a default-sized window
    // hides half of them — a property of the bar, not a thing to work around.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(1600, 1000);
    });

    await win.locator('[data-tab="insert"]').click();
    const expand = win.locator('[aria-label^="Show "]');
    if (await expand.count()) await expand.click();

    // NO CLIPPED LABELS. A menu trigger pinned to a fixed width cut its own
    // label down to "Header & foo…", which is the one thing the bar's layout
    // engine exists to make impossible.
    const clipped = await win.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".dxw-menu-select-trigger span")]
        .filter((el) => el.scrollWidth > el.clientWidth + 1)
        .map((el) => el.textContent ?? ""),
    );
    expect(clipped).toEqual([]);

    // The control says what it is. It used to say "WM".
    const watermark = win.getByRole("button", { name: "Watermark", exact: true });
    await expect(watermark).toHaveText("Watermark");
    await watermark.click();

    await win.getByLabel("Watermark picture").setInputFiles(PICTURE);

    // PAINTED, not merely reserved: a pending media part renders a
    // placeholder, so a loaded <img> on the page is the honest assertion.
    const picture = win.locator(".dxw-page img").first();
    await expect(picture).toBeAttached({ timeout: 15000 });
    await expect(picture).toHaveJSProperty("complete", true);
  } finally {
    // KILLED, not closed. A graceful close hangs once the Insert tab has been
    // opened — reproducible on this app with no watermark involved at all, so
    // it is a pre-existing quirk of that tab's teardown rather than anything
    // this test does. Waiting on it would fail the test for the wrong reason.
    app.process().kill("SIGKILL");
  }
});
