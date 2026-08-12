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

/** Every built-in the app lists out of the box, in menu order. */
const BUILT_INS = [
  "Critical reviewer",
  "Copyedit only",
  "Garner legal review",
  "Strunk & White concision",
  "Minto pyramid brief",
];

/** The rest of the shipped library, off the picker until the user adds it. */
const EXTRAS = [
  "Plain-language public writing",
  "Zinsser nonfiction",
  "Chicago editorial pass",
  "AP style news",
  "IMRaD academic",
  "Technical documentation",
  "Grant proposal",
  "Narrative craft",
];

test("the profile picker ships the built-in library and remembers the choice", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));

  const first = await launch(userData);
  const button = first.win.getByTestId("ai-profile-button");
  await expect(button).toContainText("No profile");

  await button.click();
  const menu = first.win.getByTestId("ai-profile-menu");
  // "No profile" plus the five the app lists; the extras stay out of it.
  await expect(menu.getByRole("menuitemradio")).toHaveCount(BUILT_INS.length + 1);
  for (const name of BUILT_INS) await expect(menu).toContainText(name);
  for (const name of EXTRAS) await expect(menu).not.toContainText(name);

  // The picker line stays one description per row; the disclaimer lives in
  // the manage dialog, where the profile itself is on show.
  await expect(menu).toContainText("Plain-English legal editing");

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
  const rows = dialog.getByTestId("profiles-list").locator(".profiles-row");
  await expect(rows).toHaveCount(BUILT_INS.length);

  // A built-in is read-only; the editor says so.
  await dialog.locator(".profiles-row", { hasText: "Critical reviewer" }).click();
  await expect(dialog.getByTestId("profile-instructions")).toHaveAttribute("readonly", "");
  await expect(dialog).toContainText("Duplicate it to make changes.");

  // A profile named for a person shows the method it applies and the
  // disclaimer, and the actions stay reachable below the scrolling list.
  await dialog.locator(".profiles-row", { hasText: "Garner legal review" }).click();
  await expect(dialog.getByTestId("profile-description")).toContainText(
    "Plain-English legal editing",
  );
  await expect(dialog.getByTestId("profile-disclaimer")).toContainText(
    "LikeOffice is not affiliated with or endorsed by Bryan Garner.",
  );
  await expect(dialog.getByTestId("profile-instructions")).toHaveValue(
    /Legal Writing in Plain English/,
  );
  await expect(dialog.getByTestId("profiles-new")).toBeVisible();

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
  await expect(rows).toHaveCount(BUILT_INS.length + 2);
  await dialog.getByTestId("profile-delete").click();
  await expect(rows).toHaveCount(BUILT_INS.length + 1);

  await dialog.locator(".profiles-row", { hasText: "Test voice" }).click();
  await dialog.getByTestId("profile-delete").click();
  await expect(rows).toHaveCount(BUILT_INS.length);
  await win.getByRole("button", { name: "Done" }).click();
  await expect(win.getByTestId("ai-profile-button")).toContainText("No profile");

  // Deleting a built-in hides it; restoring brings it back.
  await win.getByTestId("ai-profile-button").click();
  await win.getByTestId("ai-profile-manage").click();
  await dialog.locator(".profiles-row", { hasText: "Minto pyramid brief" }).click();
  await dialog.getByTestId("profile-delete").click();
  await expect(rows).toHaveCount(BUILT_INS.length - 1);
  await dialog.getByRole("button", { name: "Restore built-ins" }).click();
  await expect(rows).toHaveCount(BUILT_INS.length);

  await app.close();
});

test("the library the picker leaves out is one click away, and stays whole", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const { app, win } = await launch(userData);

  await win.getByTestId("ai-profile-button").click();
  await win.getByTestId("ai-profile-manage").click();
  const dialog = win.getByTestId("profiles-dialog");
  const rows = dialog.getByTestId("profiles-list").locator(".profiles-row");

  // Every profile the app no longer lists is still shipped, under one button.
  await dialog.getByTestId("profiles-add-more").click();
  const library = dialog.getByTestId("profiles-extras");
  for (const name of EXTRAS) await expect(library).toContainText(name);

  // Adding one puts it on the list, selects it, and carries its own text —
  // disclaimer included — into the editor.
  await library.getByRole("button", { name: /Chicago editorial pass/ }).click();
  await expect(rows).toHaveCount(BUILT_INS.length + 1);
  await expect(dialog.getByTestId("profile-name")).toHaveValue("Chicago editorial pass");
  await expect(dialog.getByTestId("profile-disclaimer")).toContainText(
    "not affiliated with or endorsed by the University of Chicago Press",
  );
  await expect(dialog.getByTestId("profile-instructions")).toHaveValue(
    /The Chicago Manual of Style publishes/,
  );

  await win.getByRole("button", { name: "Done" }).click();
  await expect(win.getByTestId("ai-profile-button")).toContainText("Chicago editorial pass");
  await win.getByTestId("ai-profile-button").click();
  await expect(win.getByTestId("ai-profile-menu")).toContainText("Chicago editorial pass");

  // The choice survives a relaunch, and deleting the profile only returns it
  // to the library it came from.
  await app.close();
  const second = await launch(userData);
  await expect(second.win.getByTestId("ai-profile-button")).toContainText(
    "Chicago editorial pass",
  );
  await second.win.getByTestId("ai-profile-button").click();
  await second.win.getByTestId("ai-profile-manage").click();
  const dialog2 = second.win.getByTestId("profiles-dialog");
  await dialog2.locator(".profiles-row", { hasText: "Chicago editorial pass" }).click();
  await dialog2.getByTestId("profile-delete").click();
  await expect(dialog2.getByTestId("profiles-list").locator(".profiles-row")).toHaveCount(
    BUILT_INS.length,
  );
  await dialog2.getByTestId("profiles-add-more").click();
  await expect(dialog2.getByTestId("profiles-extras")).toContainText("Chicago editorial pass");

  await second.app.close();
});

// The longest, most opinionated built-in: if the contract survives this one
// intact, it survives any of them.
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
    .getByRole("menuitemradio", { name: "Garner legal review" })
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
    'The user has selected the "Garner legal review" profile. Apply its guidance to the CONTENT you write, without changing how you use the tools:',
  );
  expect(system).toContain("Legal Writing in Plain English");
  expect(system.indexOf("Keep replies to a sentence.")).toBeLessThan(
    system.indexOf("The user has selected"),
  );

  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await app.close();
});
