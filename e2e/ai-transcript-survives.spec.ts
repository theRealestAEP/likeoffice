import { test, expect, _electron as electron } from "@playwright/test";
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

/**
 * Closing the AI panel must not destroy the conversation.
 *
 * The panel used to be unmounted on toggle, which wiped the transcript AND —
 * via the unmount cleanup — cancelled any run in progress. Cmd+Shift+A is bound
 * to that toggle, so one stray keystroke mid-answer threw away both the answer
 * and the history that produced it, with nothing said.
 */
test("the transcript survives closing and reopening the panel", async () => {
  test.setTimeout(180000);
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-transcript-"));
  const docPath = path.join(dir, "chat.docx");
  await copyFile(path.join(APP_DIR, "resources/blank.docx"), docPath);

  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const app = await electron.launch({
    args: [APP_DIR, docPath],
    env: {
      ...process.env,
      LIKEOFFICE_USER_DATA: userData,
      LIKEOFFICE_FAKE_MODEL: "1",
      ANTHROPIC: "test-key",
    },
  });
  try {
    const win = await app.firstWindow();
    await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
    await win.locator(".dxw-page").first().click();
    await win.keyboard.type("Hello from LikeOffice");
    await expect(win.locator(".dxw-page").first()).toContainText("Hello from LikeOffice");

    await win.getByTestId("ai-toggle").click();
    await win.getByTestId("ai-input").fill("Add a sentence.");
    await win.getByTestId("ai-input").press("Enter");
    // Wait for the TURN TO FINISH before snapshotting: the action row appears
    // when the edit lands, so a snapshot taken mid-turn keeps growing and the
    // comparison below would fail for a reason that has nothing to do with the
    // panel being unmounted.
    await expect(win.getByTestId("ai-suggested")).toBeVisible({ timeout: 60000 });
    const before = (await win.getByTestId("ai-transcript").innerText()).trim();
    expect(before).toContain("Add a sentence.");

    // Close, reopen — the way the menu shortcut does.
    await win.getByTestId("ai-toggle").click();
    await expect(win.getByTestId("ai-input")).toBeHidden();
    await win.getByTestId("ai-toggle").click();

    await expect(win.getByTestId("ai-transcript")).toContainText("Add a sentence.");
    expect((await win.getByTestId("ai-transcript").innerText()).trim()).toBe(before);
  } finally {
    app.process().kill("SIGKILL");
  }
});
