import { test, expect, _electron as electron } from "@playwright/test";
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

/**
 * Cmd+Z must reach the assistant's edits.
 *
 * The agent applies intents directly to the shared DocxDocument — a path the
 * editor's undo stack never saw. An AI table insert or row deletion was
 * therefore not undoable, and structural operations have no tracked form to
 * reject either, so the only way back was Revert to Saved — which autosave may
 * already have overwritten.
 */
test("undo reverses an edit the assistant made", async () => {
  test.setTimeout(180000);
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-aiundo-"));
  const docPath = path.join(dir, "undo.docx");
  await copyFile(path.join(APP_DIR, "resources/blank.docx"), docPath);

  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const app = await electron.launch({
    args: [APP_DIR, docPath],
    env: {
      ...process.env,
      LIKEOFFICE_USER_DATA: userData,
      LIKEOFFICE_FAKE_MODEL: "1",
      ANTHROPIC: "test-key",
      // Keep the file out of it: this is about the undo stack, and an autosave
      // mid-test would muddy what "back to before" means.
    },
  });
  try {
    const win = await app.firstWindow();
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
    await win.evaluate(() => window.likeoffice.setSettings({ storage: { autosave: false } }));

    const page = win.locator(".dxw-page").first();
    await page.click();
    await win.keyboard.type("Hello from the author.");
    await expect(page).toContainText("Hello from the author.");

    await win.getByTestId("ai-toggle").click();
    await win.getByTestId("ai-input").fill("Add a sentence.");
    await win.getByTestId("ai-input").press("Enter");
    // The scripted model inserts this exact text.
    await expect(page).toContainText("AI wrote this.", { timeout: 60000 });

    // Undo, through the app's own menu route rather than a synthetic key.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send("menu", "undo");
    });

    await expect(page).not.toContainText("AI wrote this.", { timeout: 30000 });
    // …and only the AI's edit went: the author's own text is still there.
    await expect(page).toContainText("Hello from the author.");
  } finally {
    app.process().kill("SIGKILL");
  }
});
