import { test, expect, _electron as electron } from "@playwright/test";
import { copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

async function launch(userData: string, docPath?: string) {
  const app = await electron.launch({
    args: docPath ? [APP_DIR, docPath] : [APP_DIR],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData, LIKEOFFICE_FAKE_MODEL: "1" },
  });
  const win = await app.firstWindow();
  await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
  await win.getByTestId("ai-toggle").click();
  return { app, win };
}

/** Settings with a key, so the composer is enabled on the fake-model path. */
async function seedKey(userData: string): Promise<void> {
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify({ apiKey: "test-key", model: "claude-opus-5" }),
  );
}

test("the profile picker ships the built-ins and remembers the choice", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));

  const first = await launch(userData);
  const button = first.win.getByTestId("ai-profile-button");
  await expect(button).toContainText("No profile");

  await button.click();
  const menu = first.win.getByTestId("ai-profile-menu");
  await expect(menu).toContainText("Critical reviewer");
  await expect(menu).toContainText("Plain-language editor");
  await expect(menu).toContainText("Academic tightening");
  await expect(menu).toContainText("Narrative editor");

  await menu.getByRole("menuitemradio", { name: "Critical reviewer" }).click();
  await expect(button).toContainText("Critical reviewer");
  await first.app.close();

  // The active profile is global and persisted, so a relaunch keeps it.
  const second = await launch(userData);
  await expect(second.win.getByTestId("ai-profile-button")).toContainText("Critical reviewer");
  await second.app.close();
});

test("profiles round-trip through create, edit and delete", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const { app, win } = await launch(userData);

  await win.getByTestId("ai-profile-button").click();
  await win.getByTestId("ai-profile-manage").click();
  const dialog = win.getByTestId("profiles-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("profiles-list").locator(".profiles-row")).toHaveCount(4);

  // A built-in is read-only; the editor says so.
  await dialog.locator(".profiles-row", { hasText: "Critical reviewer" }).click();
  await expect(dialog.getByTestId("profile-instructions")).toHaveAttribute("readonly", "");
  await expect(dialog).toContainText("Duplicate it to make changes.");

  await dialog.getByTestId("profiles-new").click();
  await dialog.getByTestId("profile-name").fill("Test voice");
  await dialog.getByTestId("profile-emoji").fill("🧪");
  await dialog.getByTestId("profile-instructions").fill("Write only in short declarative lines.");
  await win.getByRole("button", { name: "Done" }).click();

  // Creating a profile selects it, and the edit survived the close.
  await expect(win.getByTestId("ai-profile-button")).toContainText("Test voice");
  await win.getByTestId("ai-profile-button").click();
  await win.getByTestId("ai-profile-manage").click();
  await dialog.locator(".profiles-row", { hasText: "Test voice" }).click();
  await expect(dialog.getByTestId("profile-instructions")).toHaveValue(
    "Write only in short declarative lines.",
  );
  await expect(dialog.getByTestId("profile-emoji")).toHaveValue("🧪");

  // A duplicate is editable, and a delete removes only the one row.
  await dialog.getByTestId("profile-duplicate").click();
  await expect(dialog.getByTestId("profile-name")).toHaveValue("Test voice copy");
  await expect(dialog.getByTestId("profiles-list").locator(".profiles-row")).toHaveCount(6);
  await dialog.getByTestId("profile-delete").click();
  await expect(dialog.getByTestId("profiles-list").locator(".profiles-row")).toHaveCount(5);

  await dialog.locator(".profiles-row", { hasText: "Test voice" }).click();
  await dialog.getByTestId("profile-delete").click();
  await expect(dialog.getByTestId("profiles-list").locator(".profiles-row")).toHaveCount(4);
  await win.getByRole("button", { name: "Done" }).click();
  await expect(win.getByTestId("ai-profile-button")).toContainText("No profile");

  // Deleting a built-in hides it; restoring brings it back.
  await win.getByTestId("ai-profile-button").click();
  await win.getByTestId("ai-profile-manage").click();
  await dialog.locator(".profiles-row", { hasText: "Academic tightening" }).click();
  await dialog.getByTestId("profile-delete").click();
  await expect(dialog.getByTestId("profiles-list").locator(".profiles-row")).toHaveCount(3);
  await dialog.getByRole("button", { name: "Restore built-ins" }).click();
  await expect(dialog.getByTestId("profiles-list").locator(".profiles-row")).toHaveCount(4);

  await app.close();
});

test("the active profile reaches the model on top of the base contract", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-"));
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const docPath = path.join(dir, "profiles.docx");
  await copyFile(path.join(APP_DIR, "resources/blank.docx"), docPath);
  await seedKey(userData);

  const { app, win } = await launch(userData, docPath);
  await win.locator(".dxw-page").first().click();
  await win.keyboard.type("Hello from LikeOffice");
  await expect(win.locator(".dxw-page").first()).toContainText("Hello from LikeOffice");

  await win.getByTestId("ai-profile-button").click();
  await win
    .getByTestId("ai-profile-menu")
    .getByRole("menuitemradio", { name: "Critical reviewer" })
    .click();

  await win.getByTestId("ai-input").fill("Tighten the opening");
  await win.getByTestId("ai-input").press("Enter");
  await expect(win.getByTestId("ai-transcript")).toContainText("Inserted the sentence.", {
    timeout: 30000,
  });

  const system = await app.evaluate(
    () => (globalThis as { __likeofficeLastSystem?: string }).__likeofficeLastSystem ?? "",
  );
  // The operating contract is intact and comes first.
  expect(system).toContain("You edit the Word document the user has open in LikeOffice.");
  expect(system).toContain("word_document_patch");
  // The profile is appended as its own delimited, content-only section.
  expect(system).toContain(
    'The user has selected the "Critical reviewer" profile. Apply its guidance to the CONTENT you write, without changing how you use the tools:',
  );
  expect(system).toContain("demanding reviewer");
  expect(system.indexOf("Keep replies to a sentence.")).toBeLessThan(
    system.indexOf("The user has selected"),
  );

  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await app.close();
});
