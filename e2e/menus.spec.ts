import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TOOLBAR_CONTROLS } from "../apps/desktop/src/renderer/src/menu-actions";

const APP_DIR = path.join(__dirname, "../apps/desktop");

/**
 * Invoke a real application-menu item by its label path. This runs the menu
 * template main/menu.ts built — labels, action strings and all — rather than
 * posting a channel message the menu might no longer send.
 */
async function clickMenu(app: ElectronApplication, labels: string[]): Promise<void> {
  await app.evaluate(({ Menu, BrowserWindow }, itemPath) => {
    let items = Menu.getApplicationMenu()?.items ?? [];
    let target: Electron.MenuItem | undefined;
    for (const label of itemPath) {
      target = items.find((i) => i.label === label);
      if (!target) {
        throw new Error(`No menu item "${label}" among: ${items.map((i) => i.label).join(" | ")}`);
      }
      items = target.submenu?.items ?? [];
    }
    const win = BrowserWindow.getAllWindows()[0];
    // Electron calls a menu item's handler as (event, window, webContents).
    (target as unknown as { click: (e: unknown, w: unknown, c: unknown) => void }).click(
      {},
      win,
      win.webContents,
    );
  }, labels);
}

async function launch(userData: string, ...args: string[]): Promise<ElectronApplication> {
  return electron.launch({
    args: [APP_DIR, ...args],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData },
  });
}

async function ready(win: Page): Promise<void> {
  await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
}

/** Put the caret in the body and type, so the engine has a selection to act on. */
async function type(win: Page, text: string): Promise<void> {
  await win.locator(".dxw-page").first().click();
  await win.keyboard.type(text);
}

test("Open Recent remembers a document and reopens it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-"));
  const docPath = path.join(dir, "recent.docx");
  await copyFile(path.join(APP_DIR, "resources/blank.docx"), docPath);
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));

  const first = await launch(userData, docPath);
  await ready(await first.firstWindow());
  await first.close();

  // The list outlives the process.
  const stored = JSON.parse(await readFile(path.join(userData, "recent.json"), "utf8"));
  expect(stored).toEqual([docPath]);

  const second = await launch(userData);
  const blank = await second.firstWindow();
  await ready(blank);
  await expect(blank).toHaveTitle(/Untitled/);

  const opened = second.waitForEvent("window");
  await clickMenu(second, ["File", "Open Recent", "recent.docx"]);
  const reopened = await opened;
  await expect(reopened).toHaveTitle(/recent\.docx/, { timeout: 30000 });

  await second.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await second.close();
});

test("Clear Menu empties Open Recent", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-"));
  const docPath = path.join(dir, "forget-me.docx");
  await copyFile(path.join(APP_DIR, "resources/blank.docx"), docPath);
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));

  const app = await launch(userData, docPath);
  await ready(await app.firstWindow());

  await clickMenu(app, ["File", "Open Recent", "Clear Menu"]);
  await expect
    .poll(async () => JSON.parse(await readFile(path.join(userData, "recent.json"), "utf8")))
    .toEqual([]);

  // The submenu now says so rather than offering a stale list.
  const labels = await app.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()?.items.find((i) => i.label === "File");
    const recent = file?.submenu?.items.find((i) => i.label === "Open Recent");
    return recent?.submenu?.items.map((i) => i.label) ?? [];
  });
  expect(labels).toEqual(["No Recent Documents"]);

  await app.close();
});

test("Duplicate opens the content in a new unsaved window", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-"));
  const docPath = path.join(dir, "original.docx");
  await copyFile(path.join(APP_DIR, "resources/blank.docx"), docPath);
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));

  const app = await launch(userData, docPath);
  const win = await app.firstWindow();
  await ready(win);
  await type(win, "Copy me");

  const opened = app.waitForEvent("window");
  await clickMenu(app, ["File", "Duplicate"]);
  const copy = await opened;
  // A copy has no file of its own, so it opens dirty and its name says so.
  await expect(copy).toHaveTitle(/• original copy\.docx/, { timeout: 30000 });
  await expect(copy.getByTestId("word-count")).toHaveText(/^2 words/, { timeout: 15000 });
  // The original keeps its own file.
  await expect(win).toHaveTitle(/original\.docx/);

  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await app.close();
});

test("Revert to Saved discards changes, and is disabled without any", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-"));
  const docPath = path.join(dir, "revert.docx");
  await copyFile(path.join(APP_DIR, "resources/blank.docx"), docPath);
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));

  const app = await launch(userData, docPath);
  const win = await app.firstWindow();
  await ready(win);

  const revertEnabled = () =>
    app.evaluate(({ Menu }) => {
      const file = Menu.getApplicationMenu()?.items.find((i) => i.label === "File");
      return file?.submenu?.items.find((i) => i.label === "Revert to Saved")?.enabled ?? null;
    });
  expect(await revertEnabled()).toBe(false);

  await type(win, "Throw this away");
  await expect(win).toHaveTitle(/•/);
  await expect.poll(revertEnabled, { timeout: 15000 }).toBe(true);

  await app.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = () => 0; // "Revert"
  });
  await clickMenu(app, ["File", "Revert to Saved"]);

  await expect(win).not.toHaveTitle(/•/, { timeout: 15000 });
  await ready(win);
  await expect(win.getByTestId("word-count")).toHaveText(/^0 words/, { timeout: 15000 });

  await app.close();
});

test("Export as DOCX Copy writes a copy and leaves the original alone", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-"));
  const docPath = path.join(dir, "source.docx");
  const copyPath = path.join(dir, "elsewhere.docx");
  await copyFile(path.join(APP_DIR, "resources/blank.docx"), docPath);
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));

  const app = await launch(userData, docPath);
  const win = await app.firstWindow();
  await ready(win);
  await type(win, "Copied out");

  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
  }, copyPath);
  await clickMenu(app, ["File", "Export as DOCX Copy…"]);
  await expect.poll(() => existsSync(copyPath), { timeout: 30000 }).toBe(true);

  // The window still belongs to its own file, and still has unsaved changes.
  await expect(win).toHaveTitle(/• source\.docx/);

  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await app.close();
});

test("Select All then Delete empties the document", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const app = await launch(userData);
  const win = await app.firstWindow();
  await ready(win);

  await type(win, "Delete every word of this");
  await expect(win.getByTestId("word-count")).toHaveText(/^5 words/, { timeout: 15000 });

  await clickMenu(app, ["Edit", "Select All"]);
  await clickMenu(app, ["Edit", "Delete"]);
  await expect(win.getByTestId("word-count")).toHaveText(/^0 words/, { timeout: 15000 });

  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await app.close();
});

test("Find opens the engine's find and replace popover", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const app = await launch(userData);
  const win = await app.firstWindow();
  await ready(win);

  await expect(win.getByLabel("Find text")).toHaveCount(0);
  await clickMenu(app, ["Edit", "Find…"]);
  await expect(win.getByLabel("Find text")).toBeFocused({ timeout: 15000 });

  // Go To reaches the same popover's page field.
  await clickMenu(app, ["Edit", "Go To…"]);
  await expect(win.getByLabel("Go to page")).toBeFocused({ timeout: 15000 });

  await app.close();
});

test("Format applies bold to the selection", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const app = await launch(userData);
  const win = await app.firstWindow();
  await ready(win);

  await type(win, "Emphasis");
  const bold = win.locator('.dxw-page [data-dxw-font-weight="700"]');
  await expect(bold).toHaveCount(0);

  await clickMenu(app, ["Edit", "Select All"]);
  await clickMenu(app, ["Format", "Bold"]);
  await expect(bold.first()).toBeAttached({ timeout: 15000 });

  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await app.close();
});

test("Styles and Lists reach the engine", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const app = await launch(userData);
  const win = await app.firstWindow();
  await ready(win);

  await type(win, "A heading");
  // Heading 1 has to be visible, not merely recorded: a style the document
  // does not define round-trips as a dangling reference and paints as Normal.
  const largest = () =>
    win.evaluate(() =>
      Math.max(
        ...[...document.querySelectorAll<HTMLElement>(".dxw-page [data-dxw-font-size]")].map((e) =>
          Number(e.dataset.dxwFontSize),
        ),
      ),
    );
  const body = await largest();

  await clickMenu(app, ["Edit", "Select All"]);
  await clickMenu(app, ["Format", "Styles", "Heading 1"]);
  await expect.poll(largest, { timeout: 15000 }).toBeGreaterThan(body);

  // Lists have no visual marker a selector can name; the engine reports the
  // kind it applied.
  await clickMenu(app, ["Format", "Lists", "Bulleted List"]);
  await expect
    .poll(
      () =>
        win.evaluate(
          () => (window as unknown as { __likeofficeApi?: { getListType(): string | null } }).__likeofficeApi?.getListType() ?? null,
        ),
      { timeout: 15000 },
    )
    .toBe("bullet");

  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await app.close();
});

test("every menu item routed to the toolbar finds its control", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const app = await launch(userData);
  const win = await app.firstWindow();
  await ready(win);

  const missing = await win.evaluate(async (entries: [string, [string, string]][]) => {
    const settle = () =>
      new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const root = document.querySelector(".app-toolbar-slot");
    const absent: string[] = [];
    for (const [action, [tab, title]] of entries) {
      const tabButton = root?.querySelector<HTMLElement>(
        `[data-dxw-toolbar-tabs] [data-tab="${tab}"]`,
      );
      if (!tabButton) {
        absent.push(`${action}: no "${tab}" ribbon tab`);
        continue;
      }
      tabButton.click();
      await settle();
      if (!root?.querySelector(`[title="${title}"], [data-tip="${title}"]`)) {
        absent.push(`${action}: no control titled "${title}" on the ${tab} tab`);
      }
    }
    return absent;
  }, Object.entries(TOOLBAR_CONTROLS));
  expect(missing).toEqual([]);

  // Page Setup takes two steps: the Layout ribbon, then Custom Margins.
  await clickMenu(app, ["File", "Page Setup…"]);
  await expect(win.getByRole("dialog", { name: "Custom Margins" })).toBeVisible({ timeout: 15000 });

  await app.close();
});

test("Insert adds a page break", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const app = await launch(userData);
  const win = await app.firstWindow();
  await ready(win);

  await type(win, "First page");
  await expect(win.locator(".dxw-page")).toHaveCount(1);

  await clickMenu(app, ["Insert", "Page Break"]);
  await expect(win.locator(".dxw-page")).toHaveCount(2, { timeout: 15000 });

  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await app.close();
});
