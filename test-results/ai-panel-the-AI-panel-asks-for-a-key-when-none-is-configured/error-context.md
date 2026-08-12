# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: ai-panel.spec.ts >> the AI panel asks for a key when none is configured
- Location: e2e/ai-panel.spec.ts:9:5

# Error details

```
TimeoutError: electronApplication.firstWindow: Timeout 30000ms exceeded while waiting for event "window"
```

# Test source

```ts
  1  | import { test, expect, _electron as electron } from "@playwright/test";
  2  | import { execFileSync } from "node:child_process";
  3  | import { copyFile, mkdtemp, writeFile } from "node:fs/promises";
  4  | import { tmpdir } from "node:os";
  5  | import path from "node:path";
  6  | 
  7  | const APP_DIR = path.join(__dirname, "../apps/desktop");
  8  | 
  9  | test("the AI panel asks for a key when none is configured", async () => {
  10 |   const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  11 |   const app = await electron.launch({
  12 |     args: [APP_DIR],
  13 |     // ANTHROPIC="" is the app's explicit no-key override; it keeps a key in
  14 |     // the developer's .env from leaking into this test.
  15 |     env: { ...process.env, LIKEOFFICE_USER_DATA: userData, ANTHROPIC: "" },
  16 |   });
> 17 |   const win = await app.firstWindow();
     |                         ^ TimeoutError: electronApplication.firstWindow: Timeout 30000ms exceeded while waiting for event "window"
  18 |   await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
  19 | 
  20 |   await win.getByTestId("ai-toggle").click();
  21 |   await expect(win.getByTestId("ai-transcript")).toContainText("Set your Anthropic API key");
  22 |   await expect(win.getByTestId("ai-input")).toBeDisabled();
  23 | 
  24 |   await app.close();
  25 | });
  26 | 
  27 | test("the AI panel edits the document as tracked changes", async () => {
  28 |   const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-"));
  29 |   const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  30 |   const docPath = path.join(dir, "ai.docx");
  31 |   await copyFile(path.join(APP_DIR, "resources/blank.docx"), docPath);
  32 |   await writeFile(
  33 |     path.join(userData, "settings.json"),
  34 |     JSON.stringify({ apiKey: "test-key", model: "claude-opus-5" }),
  35 |   );
  36 | 
  37 |   const app = await electron.launch({
  38 |     args: [APP_DIR, docPath],
  39 |     env: { ...process.env, LIKEOFFICE_USER_DATA: userData, LIKEOFFICE_FAKE_MODEL: "1" },
  40 |   });
  41 |   const win = await app.firstWindow();
  42 |   await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
  43 | 
  44 |   await win.locator(".dxw-page").first().click();
  45 |   await win.keyboard.type("Hello from LikeOffice");
  46 |   // The scripted model searches for this text, so wait until the edit has
  47 |   // reached the document rather than only the keyboard queue.
  48 |   await expect(win.locator(".dxw-page").first()).toContainText("Hello from LikeOffice");
  49 | 
  50 |   await win.getByTestId("ai-toggle").click();
  51 |   await win.getByTestId("ai-input").fill("Add an opening sentence");
  52 |   await win.getByTestId("ai-input").press("Enter");
  53 | 
  54 |   const transcript = win.getByTestId("ai-transcript");
  55 |   await expect(transcript).toContainText("Inserted the sentence.", { timeout: 30000 });
  56 |   await expect(win.getByTestId("ai-suggested")).toContainText("suggested change");
  57 | 
  58 |   await app.evaluate(({ BrowserWindow }) => {
  59 |     BrowserWindow.getAllWindows()[0].webContents.send("menu", "save");
  60 |   });
  61 |   await expect(win).not.toHaveTitle(/•/, { timeout: 15000 });
  62 | 
  63 |   const xml = execFileSync("unzip", ["-p", docPath, "word/document.xml"], {
  64 |     encoding: "utf8",
  65 |     maxBuffer: 32 * 1024 * 1024,
  66 |   });
  67 |   expect(xml).toContain("AI wrote this.");
  68 |   expect(xml).toMatch(/<w:ins [^>]*w:author="AI"/);
  69 | 
  70 |   await app.evaluate(({ BrowserWindow }) => {
  71 |     for (const w of BrowserWindow.getAllWindows()) w.destroy();
  72 |   });
  73 |   await app.close();
  74 | });
  75 | 
```