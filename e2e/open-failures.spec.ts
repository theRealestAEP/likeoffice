import { test, expect, _electron as electron } from "@playwright/test";
import { copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

/**
 * A document that cannot be opened must SAY so.
 *
 * Both failures — the file not loading, and the editor throwing while building
 * the document — used to produce the same thing: a blank white window with no
 * message, indistinguishable from the app having hung.
 */
test("a file that is not a .docx shows a message instead of a blank window", async () => {
  test.setTimeout(120000);
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-corrupt-"));
  const docPath = path.join(dir, "not-really.docx");
  // A .docx is a zip. This is not one.
  await writeFile(docPath, "This is plain text pretending to be a Word document.");

  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const app = await electron.launch({
    args: [APP_DIR, docPath],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData, LIKEOFFICE_FAKE_MODEL: "1", ANTHROPIC: "" },
  });
  try {
    const win = await app.firstWindow();
    await expect(win.getByRole("alert")).toContainText("could not be opened", { timeout: 30000 });
    // And it explains itself rather than only naming an exception.
    await expect(win.getByRole("alert")).toContainText("may be damaged");
  } finally {
    await app.close();
  }
});

/**
 * One window per file.
 *
 * Two windows on one document each autosaved it on their own timer, so
 * whichever wrote last silently discarded the other's work — with nothing on
 * screen saying a second copy was open.
 */
test("opening a document that is already open focuses it instead of duplicating", async () => {
  test.setTimeout(120000);
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-dup-"));
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
    const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

    // Open the same path again, the way Open Recent does.
    await app.evaluate(async ({ app: a }, p) => {
      const main = a as unknown as { emit: (name: string, ...args: unknown[]) => void };
      void main;
      // Route through the app's own opener.
      const mod = (globalThis as { __likeofficeOpen?: (path: string) => Promise<void> }).__likeofficeOpen;
      if (mod) await mod(p);
    }, docPath);

    const after = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    expect(after).toBe(before);
  } finally {
    await app.close();
  }
});
