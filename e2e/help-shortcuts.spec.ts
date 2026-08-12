import { test, expect, _electron as electron, type Page } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

/**
 * The shortcuts sheet must describe the WHOLE keyboard.
 *
 * The engine builds the sheet from its own key table, so it can only list keys
 * the editor binds. The application menu takes ⌘F, ⌘S, ⌥⌘1 and the rest before
 * the renderer sees them, and the sheet used to be silent about all of it (it
 * even advertised a ⌘F that nothing bound). Main walks the live menu and hands
 * the sheet those keys; this asserts one row from each side.
 */

async function openShortcutsSheet(win: Page): Promise<void> {
  await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
  // F1 belongs to the toolbar, which mounts only once the view api exists —
  // a page can be painted before the key does anything.
  await expect(win.locator(".app-toolbar-slot button").first()).toBeAttached({ timeout: 30000 });
  await win.keyboard.press("F1");
  await expect(win.locator("[data-dxw-help-dialog]")).toBeVisible();
  await win.getByRole("tab", { name: "Shortcuts" }).click();
}

test("the shortcuts sheet lists both the menu's keys and the editor's own", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const app = await electron.launch({
    args: [APP_DIR],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData },
  });
  try {
    const win = await app.firstWindow();
    await openShortcutsSheet(win);

    // Menu-owned: the Edit menu binds ⌘F, so the engine never sees the keydown.
    await expect(win.locator('[data-dxw-help-shortcut="Find…"] kbd')).toHaveText("⌘F");
    await expect(win.locator("h3", { hasText: "Edit menu" })).toBeVisible();

    // Engine-owned: no menu item binds ⌘\, so the editor's table still supplies it.
    await expect(win.locator('[data-dxw-help-shortcut="Clear formatting"] kbd')).toHaveText("⌘\\");

    // The menu's keys carry its own labels and grouping, formatted the way the
    // engine's rows are, so the two halves read as one sheet. Nested submenus
    // are walked too: Format > Styles > Heading 1 is ⌥⌘1.
    await expect(win.locator('[data-dxw-help-shortcut="Save As…"] kbd')).toHaveText("⇧⌘S");
    await expect(win.locator('[data-dxw-help-shortcut="Print…"] kbd')).toHaveText("⌘P");
    await expect(
      win.locator("section", { has: win.locator("h3", { hasText: "Format menu" }) })
        .locator('[data-dxw-help-shortcut="Heading 1"] kbd'),
    ).toHaveText("⌥⌘1");
  } finally {
    // Destroy the windows first: a graceful quit with the sheet still open
    // takes ~35s and leaves an orphan when the body throws. See review-tab.
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.destroy();
    }).catch(() => {});
    await app.close().catch(() => {});
  }
});
