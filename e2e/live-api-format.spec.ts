import { test, expect, _electron as electron } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

// A live smoke against the Messages API, on the key the app reads from .env.
// It spends real tokens, so it only runs when explicitly requested:
//   LIKEOFFICE_LIVE_SMOKE=1 npx playwright test e2e/live-api-format.spec.ts
test.skip(!process.env.LIKEOFFICE_LIVE_SMOKE, "live smoke only runs with LIKEOFFICE_LIVE_SMOKE=1");

/**
 * The fake model proves the panel injects `suggest` into the operation it is
 * handed. This proves the same thing about an operation a real model wrote:
 * the shape it chose for a formatting ask still comes back through
 * withSuggestions and still reaches the file as a tracked property change.
 */
test("a live model's formatting change is recorded as a tracked revision", async () => {
  test.setTimeout(300000);
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-"));
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const docPath = path.join(dir, "live-format.docx");
  await copyFile(path.join(APP_DIR, "resources/blank.docx"), docPath);
  // No key here: the app reads ANTHROPIC / ANTHROPIC_API_KEY from the
  // environment or the repo's .env, so no key is written to disk by this test.
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify({ provider: "anthropic-api", model: "claude-opus-5" }),
  );

  const app = await electron.launch({
    args: [APP_DIR, docPath],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData },
  });
  const win = await app.firstWindow();
  await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });

  await win.locator(".dxw-page").first().click();
  await win.keyboard.type("Hello world");
  await expect(win.locator(".dxw-page").first()).toContainText("Hello world");

  await win.getByTestId("ai-toggle").click();
  await win.getByTestId("ai-input").fill("Make the first paragraph bold");
  await win.getByTestId("ai-input").press("Enter");
  await expect(win.getByTestId("ai-suggested")).toContainText("1 suggested change", {
    timeout: 240000,
  });

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send("menu", "save");
  });
  await expect(win).not.toHaveTitle(/•/, { timeout: 15000 });

  const xml = execFileSync("unzip", ["-p", docPath, "word/document.xml"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  expect(xml).toContain("Hello world");
  expect(xml).toContain("<w:b/>");
  expect(xml).toMatch(/<w:rPrChange [^>]*w:author="AI"/);

  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await app.close();
});

/** The words of the body, with every tag stripped. */
function bodyWords(xml: string): string[] {
  return xml
    .replace(/<w:delText[^>]*>[\s\S]*?<\/w:delText>/g, "")
    .replace(/<[^>]+>/g, "")
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "");
}

/**
 * A profile is content-only by construction, but the strongest one in the
 * library is the one worth proving on a live model: Garner's method tells it
 * to rewrite hard, and it must still reach the document through the one tool
 * the contract names, not through prose in the transcript.
 */
test("the Garner profile tightens a wordy paragraph through word_document_patch", async () => {
  test.setTimeout(300000);
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-"));
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const docPath = path.join(dir, "live-garner.docx");
  await copyFile(path.join(APP_DIR, "resources/blank.docx"), docPath);
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify({ provider: "anthropic-api", model: "claude-opus-5" }),
  );

  const app = await electron.launch({
    args: [APP_DIR, docPath],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData },
  });
  const win = await app.firstWindow();
  await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });

  const wordy =
    "Pursuant to the provisions of Section 4.2 hereof, and notwithstanding " +
    "anything to the contrary contained herein, it should be noted that the " +
    "Contractor shall be required to make a determination as to whether or not " +
    "the aforementioned deliverables are in compliance with the specifications " +
    "set forth in Exhibit A, and in the event that a determination is made that " +
    "such deliverables are not in compliance, the Contractor shall be obligated " +
    "to provide notification to the Client within a period of ten (10) days.";
  const before = wordy.split(/\s+/).length;

  await win.locator(".dxw-page").first().click();
  await win.keyboard.type(wordy);
  await expect(win.locator(".dxw-page").first()).toContainText("Exhibit A");

  await win.getByTestId("ai-toggle").click();
  await win.getByTestId("ai-profile-button").click();
  await win
    .getByTestId("ai-profile-menu")
    .getByRole("menuitemradio", { name: "Garner legal review" })
    .click();

  await win.getByTestId("ai-input").fill("Tighten this paragraph.");
  await win.getByTestId("ai-input").press("Enter");
  await expect(win.getByTestId("ai-suggested")).toContainText("suggested change", {
    timeout: 240000,
  });

  // The tool contract held: the rewrite came through the text patch tool.
  await expect(win.getByTestId("ai-transcript")).toContainText("word_document_patch");

  await win.getByRole("button", { name: "Accept all" }).click();
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send("menu", "save");
  });
  await expect(win).not.toHaveTitle(/•/, { timeout: 15000 });

  const xml = execFileSync("unzip", ["-p", docPath, "word/document.xml"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const after = bodyWords(xml);
  console.log(`BEFORE (${before} words): ${wordy}`);
  console.log(`AFTER (${after.length} words): ${after.join(" ")}`);
  // Garner's method is a cutting method: the paragraph comes back materially
  // shorter, and Exhibit A survives as the term of art it is.
  expect(after.length).toBeLessThan(before * 0.8);
  expect(after.join(" ")).toContain("Exhibit A");

  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await app.close();
});
