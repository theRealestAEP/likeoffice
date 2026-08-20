import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

/**
 * The app calls itself LikeOffice, unpackaged too.
 *
 * `productName` in electron-builder.yml only names the PACKAGED build. Run from
 * source, Electron takes its name from the binary, so the Dock, the About panel
 * and the app menu's Hide/Quit items all said "Electron" while the menu bar
 * beside them said LikeOffice.
 */
test("the app is named LikeOffice, not Electron", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-name-"));
  const app = await electron.launch({
    args: [APP_DIR],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData, LIKEOFFICE_FAKE_MODEL: "1", ANTHROPIC: "" },
  });
  try {
    const win = await app.firstWindow();
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });

    // app.name is what the roles interpolate: "About Electron", "Quit Electron".
    expect(await app.evaluate(({ app: a }) => a.name)).toBe("LikeOffice");
    expect(await app.evaluate(({ app: a }) => a.getName())).toBe("LikeOffice");

    // The window title carries it too.
    await expect(win).toHaveTitle(/LikeOffice$/);

    // And the first app menu is ours, not the default one. Only macOS HAS an
    // application menu — on Windows and Linux the template starts at File, so
    // asserting "LikeOffice" there tests the platform, not the app.
    const firstMenu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items[0]?.label);
    expect(firstMenu).toBe(process.platform === "darwin" ? "LikeOffice" : "File");
  } finally {
    await app.close();
  }
});
