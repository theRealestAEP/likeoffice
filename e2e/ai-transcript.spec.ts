import { test, expect, _electron as electron } from "@playwright/test";
import { copyFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

/**
 * A long conversation must not deform the one behind it. The tool pills were
 * flex children that hide their overflow, which zeroes their automatic
 * minimum height: once the transcript overflowed its column, every pill
 * flattened and clipped its own label. This drives the real panel to a
 * transcript of forty-odd entries and measures what the user would see.
 */
test("a long transcript keeps every entry its own size", async () => {
  // This test is far and away the heaviest in the suite: it launches the app,
  // then drives TEN sequential model round trips to build a forty-odd entry
  // transcript, then measures layout twice at two panel widths. The suite's
  // 60s default cannot hold that on a slow machine — and the test's own inner
  // budgets say so, asking for up to 30s of launch plus 60s per ask, which is
  // already more than the 60s total it was allowed. It fit only while every
  // step happened to be fast; CI's Linux runner (~5x slower than a dev Mac
  // here, 8.3s average per e2e test against ~1.5s) blew straight through it.
  //
  // The budget is the thing that was wrong, so the budget is what changes.
  // Every assertion below is untouched, including the per-step timeouts.
  test.setTimeout(180000);

  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-"));
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const docPath = path.join(dir, "transcript.docx");
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

  const transcript = win.getByTestId("ai-transcript");
  const entries = transcript.locator(".ai-entry");
  const asks = [
    "Add an opening sentence",
    "Make the first word bold",
    "Tighten the opening paragraph and keep the meaning exactly as it is now",
    "supercalifragilisticexpialidociousnessunbrokenstringwithnospacesinitatall",
    "Insert a heading",
    "Fix the punctuation",
    "Add a closing line",
    "Bold the title",
    "Rewrite the second sentence",
    "Add one more sentence",
  ];
  for (const ask of asks) {
    const before = await entries.count();
    await win.getByTestId("ai-input").fill(ask);
    await win.getByTestId("ai-input").press("Enter");
    await expect(entries).not.toHaveCount(before, { timeout: 60000 });
    await expect(win.getByTestId("ai-activity")).toHaveCount(0, { timeout: 60000 });
  }
  // Each turn adds the ask, two tool pills, and the reply.
  expect(await entries.count()).toBeGreaterThanOrEqual(asks.length * 4);

  // Every pill kept its intrinsic height, at the panel's width and narrower.
  for (const width of ["", "240px"]) {
    await win.locator(".ai-panel").evaluate((el: HTMLElement, w) => (el.style.width = w), width);
    const heights = await transcript
      .locator(".ai-entry-tool")
      .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
    expect(new Set(heights).size).toBe(1);
    expect(heights[0]).toBeGreaterThan(16);

    // Nothing spills sideways, and the view is still pinned to the newest
    // entry after all that.
    const box = await transcript.evaluate((el) => ({
      overflow: el.scrollWidth - el.clientWidth,
      fromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
    }));
    expect(box.overflow).toBeLessThanOrEqual(0);
    expect(box.fromBottom).toBeLessThan(40);
  }

  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await app.close();
});
