import { test, expect, _electron as electron } from "@playwright/test";
import { copyFile, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

/**
 * Autosave, from the user's side: does the FILE ON DISK change without anyone
 * pressing Save?
 *
 * It used to write only a recovery copy inside userData, which meant a document
 * edited for an hour was still stale on disk and nothing on screen said so.
 * These assertions are deliberately about the file and the status text, not
 * about the IPC — those are the two things a user can actually observe.
 */
test("autosave writes the document's own file, and says when", async () => {
  test.setTimeout(180000);
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-autosave-"));
  const docPath = path.join(dir, "notes.docx");
  await copyFile(path.join(APP_DIR, "resources/blank.docx"), docPath);
  const before = await stat(docPath);

  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const app = await electron.launch({
    args: [APP_DIR, docPath],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData, LIKEOFFICE_FAKE_MODEL: "1", ANTHROPIC: "" },
  });
  try {
    const win = await app.firstWindow();
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });

    // The shortest interval the settings offer, so the test waits seconds
    // rather than the default half-minute.
    await win.evaluate(() => window.likeoffice.setSettings({ storage: { autosaveSeconds: 5 } }));
    // The interval is read from settings at render, so the change has to reach
    // the component before the edit — reload the view the way the app does.
    await win.reload();
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });

    await win.locator(".dxw-page").first().click();
    await win.keyboard.type("Autosaved without pressing save.");
    await expect(win).toHaveTitle(/•/);

    // The file changes on its own…
    await expect
      .poll(async () => (await stat(docPath)).mtimeMs, { timeout: 30000 })
      .not.toBe(before.mtimeMs);
    const saved = await readFile(docPath);
    expect(saved.byteLength).toBeGreaterThan(before.size - 1);

    // …and the window stops claiming unsaved changes and says when it saved.
    await expect(win.getByTestId("save-status")).toContainText(/Saved/, { timeout: 30000 });
    await expect(win).not.toHaveTitle(/•/);

    // THE STATUS MUST NOT OUTLIVE ITS TRUTH. An earlier version tested savedAt
    // before dirty, so once anything had been saved the header read "Saved
    // 12:04" through every later edit — the one indicator of what is on disk,
    // reporting the past. Typing again has to take it back to unsaved.
    await win.keyboard.type(" more");
    await expect(win.getByTestId("save-status")).toContainText("Unsaved changes");
  } finally {
    // Ends DIRTY by design, so it has to be killed rather than closed — see the
    // note in the test below.
    app.process().kill("SIGKILL");
  }
});

test("autosave off leaves the file alone but still keeps a recovery copy", async () => {
  test.setTimeout(180000);
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-autosave-off-"));
  const docPath = path.join(dir, "notes.docx");
  await copyFile(path.join(APP_DIR, "resources/blank.docx"), docPath);
  const before = await stat(docPath);

  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const app = await electron.launch({
    args: [APP_DIR, docPath],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData, LIKEOFFICE_FAKE_MODEL: "1", ANTHROPIC: "" },
  });
  try {
    const win = await app.firstWindow();
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
    await win.evaluate(() =>
      window.likeoffice.setSettings({ storage: { autosave: false, autosaveSeconds: 5 } }),
    );
    await win.reload();
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });

    await win.locator(".dxw-page").first().click();
    await win.keyboard.type("Not written to my file.");

    // Long enough for several intervals to have fired.
    await win.waitForTimeout(12000);
    expect((await stat(docPath)).mtimeMs).toBe(before.mtimeMs);
    // Still dirty, because nothing wrote the file.
    await expect(win).toHaveTitle(/•/);

    // The recovery copy is written regardless: "do not touch my file" is not
    // "lose my work if the app dies".
    const recovery = await win.evaluate(() => window.likeoffice.autosave(new Uint8Array([1, 2, 3])));
    expect(recovery).toBeNull();
  } finally {
    // KILLED, not closed. This test ends with a DIRTY document on purpose, and
    // closing one puts up the native "Save changes?" box — which waits for a
    // human and hangs the run. Any spec that leaves unsaved changes has to end
    // this way.
    app.process().kill("SIGKILL");
  }
});
