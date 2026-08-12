import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

// Under LIKEOFFICE_FAKE_MODEL the main process reports both CLIs as not
// installed, so the not-installed hints render deterministically on any
// machine.
test("the settings dialog offers providers and degrades gracefully", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const app = await electron.launch({
    args: [APP_DIR],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData, LIKEOFFICE_FAKE_MODEL: "1", ANTHROPIC: "" },
  });
  const win = await app.firstWindow();
  await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send("menu", "settings");
  });

  const provider = win.getByTestId("settings-provider");
  await expect(provider).toBeVisible();
  await expect(provider.locator("option")).toHaveCount(3);
  await expect(win.getByTestId("provider-status")).toContainText("No API key is set.");

  await provider.selectOption("claude-subscription");
  await expect(win.getByTestId("provider-status")).toContainText("Claude Code is not installed");
  await expect(win.getByTestId("provider-status")).toContainText(
    "npm install -g @anthropic-ai/claude-code",
  );

  await provider.selectOption("codex-subscription");
  await expect(win.getByTestId("provider-status")).toContainText("Codex is not installed");
  await expect(win.getByTestId("provider-status")).toContainText("npm install -g @openai/codex");

  // The provider choice persists through save. Saving is asynchronous and the
  // dialog closes only once the write resolves, so re-opening before that
  // lands leaves the pending close to shut the dialog the assertion needs.
  await win.getByRole("button", { name: "Save" }).click();
  await expect(provider).toBeHidden();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send("menu", "settings");
  });
  await expect(win.getByTestId("settings-provider")).toHaveValue("codex-subscription");

  await app.close();
});
