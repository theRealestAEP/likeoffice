import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

// The full loop the AI panel promises: the model records tracked changes and
// the toolbar's Review tab is where the user accepts them into the document.
test("the Review tab accepts changes the AI suggested", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-"));
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const docPath = path.join(dir, "review.docx");
  await copyFile(path.join(APP_DIR, "resources/blank.docx"), docPath);
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify({ apiKey: "test-key", model: "claude-opus-5" }),
  );

  const app = await electron.launch({
    args: [APP_DIR, docPath],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData, LIKEOFFICE_FAKE_MODEL: "1" },
  });
  const win = await app.firstWindow();
  await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });

  await win.locator(".dxw-page").first().click();
  await win.keyboard.type("Hello from LikeOffice");
  await expect(win.locator(".dxw-page").first()).toContainText("Hello from LikeOffice");

  await win.getByTestId("ai-toggle").click();
  await win.getByTestId("ai-input").fill("Add an opening sentence");
  await win.getByTestId("ai-input").press("Enter");
  await expect(win.getByTestId("ai-suggested")).toContainText("suggested change", {
    timeout: 30000,
  });

  const toolbar = win.locator("[data-dxw-toolbar-mode]");
  await toolbar.getByRole("button", { name: /^review$/i }).click();
  await expect(toolbar.locator("[data-dxw-revision-count]")).toContainText("1 change");

  await toolbar.getByRole("button", { name: /^accept/i }).click();
  await win.getByRole("option", { name: /accept all changes/i }).click();
  await expect(toolbar.locator("[data-dxw-revision-count]")).not.toContainText("1 change");

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send("menu", "save");
  });
  await expect(win).not.toHaveTitle(/•/, { timeout: 15000 });

  // Accepted means the text stays and the tracked-change wrapper is gone.
  const xml = execFileSync("unzip", ["-p", docPath, "word/document.xml"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  expect(xml).toContain("AI wrote this.");
  expect(xml).not.toContain("<w:ins ");

  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await app.close();
});

/**
 * A formatting change is the other half of the promise. The panel says every
 * edit is recorded for the user to accept or reject, and until the suggest
 * flag reached every suggestable operation only insertions kept that promise:
 * a formatRun wrote straight into the document with no revision behind the
 * Accept all and Reject all the panel offers.
 */
async function boldTurn(docPath: string, userData: string) {
  await copyFile(path.join(APP_DIR, "resources/blank.docx"), docPath);
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify({ apiKey: "test-key", model: "claude-opus-5" }),
  );

  const app = await electron.launch({
    args: [APP_DIR, docPath],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData, LIKEOFFICE_FAKE_MODEL: "1" },
  });
  const win = await app.firstWindow();
  await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });

  await win.locator(".dxw-page").first().click();
  await win.keyboard.type("Hello from LikeOffice");
  await expect(win.locator(".dxw-page").first()).toContainText("Hello from LikeOffice");

  await win.getByTestId("ai-toggle").click();
  await win.getByTestId("ai-input").fill("Make the first paragraph bold");
  await win.getByTestId("ai-input").press("Enter");
  // The count is api.revisionCount(): the engine holds a revision for the
  // formatting change, not just a formatted run.
  await expect(win.getByTestId("ai-suggested")).toContainText("1 suggested change", {
    timeout: 30000,
  });

  const toolbar = win.locator("[data-dxw-toolbar-mode]");
  await toolbar.getByRole("button", { name: /^review$/i }).click();
  await expect(toolbar.locator("[data-dxw-revision-count]")).toContainText("1 change");
  return { app, win, toolbar };
}

async function saveAndRead(app: ElectronApplication, win: Page, docPath: string): Promise<string> {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send("menu", "save");
  });
  await expect(win).not.toHaveTitle(/•/, { timeout: 15000 });
  return execFileSync("unzip", ["-p", docPath, "word/document.xml"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

test("the Review tab rejects an AI formatting change", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-"));
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const docPath = path.join(dir, "bold-reject.docx");
  const { app, win, toolbar } = await boldTurn(docPath, userData);

  // The tracked form reaches the file: a property change, authored by the AI.
  const suggested = await saveAndRead(app, win, docPath);
  expect(suggested).toMatch(/<w:rPrChange [^>]*w:author="AI"/);
  expect(suggested).toContain("<w:b/>");

  await toolbar.getByRole("button", { name: /^reject/i }).click();
  await win.getByRole("option", { name: /reject all changes/i }).click();
  await expect(toolbar.locator("[data-dxw-revision-count]")).not.toContainText("1 change");

  // Rejected means the original formatting is back and nothing is tracked.
  const rejected = await saveAndRead(app, win, docPath);
  expect(rejected).toContain("Hello from LikeOffice");
  expect(rejected).not.toContain("<w:rPrChange ");
  expect(rejected).not.toContain("<w:b/>");

  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await app.close();
});

test("the Review tab accepts an AI formatting change", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-"));
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const docPath = path.join(dir, "bold-accept.docx");
  const { app, win, toolbar } = await boldTurn(docPath, userData);

  await toolbar.getByRole("button", { name: /^accept/i }).click();
  await win.getByRole("option", { name: /accept all changes/i }).click();
  await expect(toolbar.locator("[data-dxw-revision-count]")).not.toContainText("1 change");

  // Accepted means the bold stays and the tracked-change record is gone.
  const accepted = await saveAndRead(app, win, docPath);
  expect(accepted).toContain("Hello from LikeOffice");
  expect(accepted).toContain("<w:b/>");
  expect(accepted).not.toContain("<w:rPrChange ");

  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await app.close();
});
