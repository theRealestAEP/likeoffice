import { test, expect, _electron as electron } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

// A live smoke against the user's Claude Code login. It spends real usage, so
// it only runs when explicitly requested:
//   LIKEOFFICE_LIVE_SMOKE=1 npx playwright test e2e/live-claude-subscription.spec.ts
test.skip(!process.env.LIKEOFFICE_LIVE_SMOKE, "live smoke only runs with LIKEOFFICE_LIVE_SMOKE=1");

/** Launch the app on a blank document with the subscription provider selected,
 * type `seed`, send `ask` to the AI panel, save, and hand back the saved XML. */
async function runOneTurn(seed: string, ask: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-"));
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const docPath = path.join(dir, "smoke.docx");
  await copyFile(path.join(APP_DIR, "resources/blank.docx"), docPath);
  await writeFile(
    path.join(userData, "settings.json"),
    JSON.stringify({ provider: "claude-subscription", apiKey: "", model: "claude-sonnet-5" }),
  );

  const app = await electron.launch({
    args: [APP_DIR, docPath],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData, ANTHROPIC: "" },
  });
  const win = await app.firstWindow();
  await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });

  await win.locator(".dxw-page").first().click();
  await win.keyboard.type(seed);
  await expect(win.locator(".dxw-page").first()).toContainText(seed);

  await win.getByTestId("ai-toggle").click();
  await win.getByTestId("ai-input").fill(ask);
  await win.getByTestId("ai-input").press("Enter");

  await expect(win.getByTestId("ai-suggested")).toContainText("suggested change", {
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

  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await app.close();
  return xml;
}

test("a claude-subscription session lands a tracked change via the MCP bridge", async () => {
  test.setTimeout(300000);
  const xml = await runOneTurn("Hello world", "Replace Hello with Goodbye");
  expect(xml).toContain("Goodbye");
  expect(xml).toMatch(/<w:(ins|del) [^>]*w:author="AI"/);
});

// The edit tool's schema is the only one large enough to carry $defs — 45 of
// them, and 138 $refs into them. main/agent.ts hands raw engine schemas to the
// MCP bridge, so nothing between the engine and the Claude Agent SDK is known
// to preserve a reference; the test above never finds out, because rewording
// text goes through word_document_patch, whose schema has no $ref in it.
//
// Bold does go through word_document_edit, and through the split the engine
// ships: formatRun addresses the run with blockRef and runRef written out in
// full, and takes what to write as {"$ref":"#/$defs/patch"}. So this asks the
// model to fill a referenced shape it can only have read through the bridge.
test("the model fills a $ref'd shape in an edit-tool schema over the bridge", async () => {
  test.setTimeout(300000);
  const xml = await runOneTurn("Hello world", "Make the text bold");
  // Bold on the run that holds the text, which is a formatRun whose `patch`
  // the model could only have written from behind a $ref.
  expect(xml).toMatch(/<w:rPr><w:b\/>[^]*?<w:t[^>]*>Hello world<\/w:t>/);
  // No tracked-change assertion here, unlike the test above. AiPanel.tsx's
  // withSuggestions injects `suggest` for insertText and splitParagraph only,
  // so the panel applies an AI formatting change straight to the document. The
  // engine does support it — formatRun with suggest writes a w:rPrChange — so
  // this is the panel's rule, not a missing capability.
});
