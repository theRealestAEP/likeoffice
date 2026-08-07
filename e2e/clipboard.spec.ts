import { test, expect, _electron as electron } from "@playwright/test";
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

async function launchWithDoc() {
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-clipboard-"));
  const docPath = path.join(dir, "clipboard.docx");
  await copyFile(path.join(APP_DIR, "resources/blank.docx"), docPath);
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const app = await electron.launch({
    args: [APP_DIR, docPath],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData },
  });
  const win = await app.firstWindow();
  await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
  return { app, win };
}

/** Close without the dirty-document save dialog (it blocks a test run). */
async function closeApp(app: Awaited<ReturnType<typeof launchWithDoc>>["app"]) {
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await app.close();
}

function pageText(win: Awaited<ReturnType<typeof launchWithDoc>>["win"]) {
  return win.locator(".dxw-page").first().innerText();
}

/** Text spans with the run formatting the engine rendered them with. */
function spanProps(win: Awaited<ReturnType<typeof launchWithDoc>>["win"]) {
  return win.locator(".dxw-page").first().evaluate((el) =>
    Array.from(el.querySelectorAll("[data-dxw-item-kind='text']"))
      .map((s) => ({
        text: s.textContent ?? "",
        weight: s.getAttribute("data-dxw-font-weight"),
        size: s.getAttribute("data-dxw-font-size"),
      }))
      .filter((s) => s.text),
  );
}

test("undo removes a rich paste in one step; redo restores it", async () => {
  const { app, win } = await launchWithDoc();
  await win.locator(".dxw-page").first().click();
  await win.keyboard.type("Typed.");

  await app.evaluate(({ clipboard }) =>
    clipboard.write({
      text: "Bold text",
      html: "<p><b>Bold</b> text</p><p>Second para</p>",
    }),
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.paste(),
  );
  await expect.poll(() => pageText(win)).toContain("Bold");

  // One menu undo removes the entire paste (both paragraphs), nothing else.
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send("menu", "undo"),
  );
  await expect.poll(() => pageText(win)).not.toContain("Bold");
  expect(await pageText(win)).toContain("Typed.");

  // Redo restores the paste.
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send("menu", "redo"),
  );
  await expect.poll(() => pageText(win)).toContain("Second");

  // Cmd+Z reaching the editor directly also undoes the paste, and a second
  // undo removes the typed text too.
  await win.keyboard.press("Meta+z");
  await expect.poll(() => pageText(win)).not.toContain("Bold");
  await win.keyboard.press("Meta+z");
  await expect.poll(() => pageText(win)).not.toContain("Typed.");

  await closeApp(app);
});

test("undo removes a plain-text paste", async () => {
  const { app, win } = await launchWithDoc();
  await win.locator(".dxw-page").first().click();
  await win.keyboard.type("Typed.");

  await app.evaluate(({ clipboard }) => clipboard.writeText("PASTEDPLAIN"));
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.paste(),
  );
  await expect.poll(() => pageText(win)).toContain("PASTEDPLAIN");

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send("menu", "undo"),
  );
  await expect.poll(() => pageText(win)).not.toContain("PASTEDPLAIN");
  expect(await pageText(win)).toContain("Typed.");

  await closeApp(app);
});

test("Paste and Match Style menu item exists and pastes without formatting", async () => {
  const { app, win } = await launchWithDoc();

  // The Edit menu carries the item with the Cmd+Shift+V accelerator.
  const item = await app.evaluate(({ Menu }) => {
    const edit = Menu.getApplicationMenu()
      ?.items.find((i) => i.label === "Edit");
    const match = edit?.submenu?.items.find((i) => i.role === "pasteandmatchstyle");
    return match ? { label: match.label, accelerator: match.accelerator } : null;
  });
  expect(item).not.toBeNull();
  expect(item!.accelerator).toBe("Shift+CmdOrCtrl+V");

  await win.locator(".dxw-page").first().click();
  await win.keyboard.type("Typed.");

  await app.evaluate(({ clipboard }) =>
    clipboard.write({
      text: "Styled text",
      html: '<p><b style="font-size:30px">Styled</b> text</p>',
    }),
  );
  // What the menu item triggers.
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.pasteAndMatchStyle(),
  );
  await expect.poll(() => pageText(win)).toContain("Styled");

  // Every rendered span kept the destination formatting: regular weight,
  // the document's own font size — nothing bold, nothing 30px.
  const spans = await spanProps(win);
  expect(spans.length).toBeGreaterThan(0);
  for (const span of spans) {
    expect(span.weight, `span "${span.text}" stays regular weight`).toBe("400");
    expect(Number(span.size), `span "${span.text}" keeps the document size`).toBeLessThan(20);
  }

  await closeApp(app);
});
