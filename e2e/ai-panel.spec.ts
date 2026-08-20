import { test, expect, _electron as electron } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

test("the AI panel asks for a key when none is configured", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const app = await electron.launch({
    args: [APP_DIR],
    // ANTHROPIC="" is the app's explicit no-key override; it keeps a key in
    // the developer's .env from leaking into this test.
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData, ANTHROPIC: "" },
  });
  const win = await app.firstWindow();
  await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });

  await win.getByTestId("ai-toggle").click();
  await expect(win.getByTestId("ai-transcript")).toContainText("Add a key for Anthropic");
  await expect(win.getByTestId("ai-input")).toBeDisabled();

  await app.close();
});

test("the AI panel edits the document as tracked changes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-"));
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const docPath = path.join(dir, "ai.docx");
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
  // The scripted model searches for this text, so wait until the edit has
  // reached the document rather than only the keyboard queue.
  await expect(win.locator(".dxw-page").first()).toContainText("Hello from LikeOffice");

  await win.getByTestId("ai-toggle").click();
  await win.getByTestId("ai-input").fill("Add an opening sentence");
  await win.getByTestId("ai-input").press("Enter");

  const transcript = win.getByTestId("ai-transcript");
  await expect(transcript).toContainText("Inserted the sentence.", { timeout: 30000 });
  await expect(win.getByTestId("ai-suggested")).toContainText("suggested change");

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send("menu", "save");
  });
  await expect(win).not.toHaveTitle(/•/, { timeout: 15000 });

  const xml = execFileSync("unzip", ["-p", docPath, "word/document.xml"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  expect(xml).toContain("AI wrote this.");
  expect(xml).toMatch(/<w:ins [^>]*w:author="AI"/);

  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await app.close();
});
