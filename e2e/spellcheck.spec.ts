import { test, expect, _electron as electron } from "@playwright/test";
import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

/**
 * The native popup itself needs a human, so spell:menu exposes two seams:
 * it stashes the built template on globalThis.__lastSpellMenu (asserted
 * here), and LIKEOFFICE_SPELL_MENU_AUTOPICK scripts the pick without a
 * popup. The pure template builder is unit-tested in spellmenu-unit.spec.ts.
 */
async function launchWithDoc(autopick: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-spell-"));
  const docPath = path.join(dir, "spell.docx");
  await copyFile(path.join(APP_DIR, "resources/blank.docx"), docPath);
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const app = await electron.launch({
    args: [APP_DIR, docPath],
    env: {
      ...process.env,
      LIKEOFFICE_USER_DATA: userData,
      LIKEOFFICE_SPELL_MENU_AUTOPICK: autopick,
    },
  });
  const win = await app.firstWindow();
  await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
  return { app, win, userData };
}

async function closeApp(app: Awaited<ReturnType<typeof launchWithDoc>>["app"]) {
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await app.close();
}

function pageText(win: Awaited<ReturnType<typeof launchWithDoc>>["win"]) {
  return win.locator(".dxw-page").first().innerText();
}

interface StashedMenu {
  word: string;
  suggestions: string[];
  template: {
    type?: string;
    label?: string;
    role?: string;
    enabled?: boolean;
    action?: { type: string; text?: string };
  }[];
}

test("misspelled word gets a squiggle; the native menu offers suggestions and replaces through the editing path", async () => {
  const { app, win } = await launchWithDoc("first-suggestion");

  await win.locator(".dxw-page").first().click();
  await win.keyboard.type("Helllo world");

  // Only the misspelled word is marked (the scan is debounced).
  const squiggle = win.locator(".lo-squiggle");
  await expect(squiggle).toHaveCount(1, { timeout: 15000 });

  // The engine coalesces same-kind edits within 1s into one undo entry; a
  // human picking from a native menu is always slower than that, but the
  // autopick seam is not, so wait the window out for a clean undo step.
  await win.waitForTimeout(1200);

  // Right-click the squiggled word: the capture-phase handler intercepts
  // BEFORE the engine's own DOM context menu and asks main for a native menu.
  const box = (await squiggle.boundingBox())!;
  await win.mouse.click(box.x + box.width / 2, box.y - 4, { button: "right" });

  await expect
    .poll(async () => (await app.evaluate(() => (globalThis as { __lastSpellMenu?: unknown }).__lastSpellMenu)) != null, {
      timeout: 10000,
    })
    .toBe(true);
  const menu = (await app.evaluate(
    () => (globalThis as { __lastSpellMenu?: unknown }).__lastSpellMenu,
  )) as StashedMenu;

  // The menu carries real dictionary suggestions for the word under the
  // cursor, Add to Dictionary, and the standard clipboard items.
  expect(menu.word).toBe("Helllo");
  expect(menu.suggestions).toContain("Hello");
  const replaceItems = menu.template.filter((i) => i.action?.type === "replace");
  expect(replaceItems.length).toBeGreaterThan(0);
  expect(replaceItems[0].label).toBe(menu.suggestions[0]);
  expect(menu.template.some((i) => i.action?.type === "add-word")).toBe(true);
  for (const role of ["cut", "copy", "paste"]) {
    expect(menu.template.some((i) => i.role === role)).toBe(true);
  }

  // The autopick chose the first suggestion; the replacement went through the
  // engine's typing path, so the text changed and the engine's own dom menu
  // never appeared.
  await expect.poll(() => pageText(win)).not.toContain("Helllo");
  expect(await pageText(win)).toContain("world");
  expect(await win.locator("[data-dxw-text-context-menu]").count()).toBe(0);

  // Same path as typing: one undo restores the misspelling.
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send("menu", "undo"),
  );
  await expect.poll(() => pageText(win)).toContain("Helllo");

  await closeApp(app);
});

test("Add to Dictionary persists the word and clears its squiggle", async () => {
  const { app, win, userData } = await launchWithDoc("add-word");

  await win.locator(".dxw-page").first().click();
  await win.keyboard.type("Zorbling ahead");
  const squiggle = win.locator(".lo-squiggle");
  await expect(squiggle).toHaveCount(1, { timeout: 15000 });

  const box = (await squiggle.boundingBox())!;
  await win.mouse.click(box.x + box.width / 2, box.y - 4, { button: "right" });

  // The word joins the custom dictionary and the squiggle disappears on the
  // re-scan; the text itself is untouched.
  await expect(squiggle).toHaveCount(0, { timeout: 15000 });
  expect(await pageText(win)).toContain("Zorbling");
  const saved = JSON.parse(
    await readFile(path.join(userData, "custom-dictionary.json"), "utf8"),
  );
  expect(saved).toContain("Zorbling");

  await closeApp(app);
});

test("spellcheck honors the settings language override", async () => {
  const { app, win } = await launchWithDoc("first-suggestion");

  await win.locator(".dxw-page").first().click();
  await win.keyboard.type("Helllo again");
  await expect(win.locator(".lo-squiggle")).toHaveCount(1, { timeout: 15000 });

  // Turning spellcheck off in settings clears the marks.
  await win.evaluate(() =>
    window.likeoffice.setSettings(null, "claude-opus-5", "anthropic-api", "off"),
  );
  await expect(win.locator(".lo-squiggle")).toHaveCount(0, { timeout: 15000 });

  // And back on again re-marks the word.
  await win.evaluate(() =>
    window.likeoffice.setSettings(null, "claude-opus-5", "anthropic-api", "en-US"),
  );
  await expect(win.locator(".lo-squiggle")).toHaveCount(1, { timeout: 15000 });

  await closeApp(app);
});
