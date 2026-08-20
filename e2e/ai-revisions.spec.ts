import { test, expect, _electron as electron } from "@playwright/test";
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

/**
 * The panel's Accept/Reject All must resolve only what the ASSISTANT wrote.
 *
 * They used to be document-wide. Open a file carrying a colleague's tracked
 * changes, ask the AI for one edit, press "Reject all", and the colleague's
 * revisions were silently destroyed — and the "N suggested changes" count had
 * been describing theirs too.
 */
test("Reject all leaves another author's tracked changes untouched", async () => {
  test.setTimeout(180000);
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-rev-"));
  const docPath = path.join(dir, "review.docx");
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

    // A co-author's tracked change, made the way a human reviewer's would be:
    // suggesting mode on, authored by someone who is not the assistant.
    await win.locator(".dxw-page").first().click();
    await win.evaluate(() => {
      const api = (window as unknown as { __likeofficeApi: {
        setSuggesting(on: boolean, author?: string): void;
      } }).__likeofficeApi;
      api.setSuggesting(true, "Dana");
    });
    // The scripted model searches for "Hello", so the text it will find has to
    // be there — and it is Dana's tracked insertion, which is the point.
    await win.keyboard.type("Hello from Dana. ");
    await expect(win.locator(".dxw-page").first()).toContainText("Hello from Dana.");
    await win.evaluate(() => {
      const api = (window as unknown as { __likeofficeApi: {
        setSuggesting(on: boolean, author?: string): void;
        revisionCount(author?: string): number;
      } }).__likeofficeApi;
      api.setSuggesting(false);
    });
    const danaBefore = await win.evaluate(() =>
      (window as unknown as { __likeofficeApi: { revisionCount(a?: string): number } })
        .__likeofficeApi.revisionCount("Dana"),
    );
    expect(danaBefore).toBeGreaterThan(0);

    // The assistant makes its own edit (the fake model always edits).
    await win.getByTestId("ai-toggle").click();
    await win.getByTestId("ai-input").fill("Add a sentence.");
    await win.getByTestId("ai-input").press("Enter");
    await expect(win.getByTestId("ai-suggested")).toBeVisible({ timeout: 60000 });

    // The count describes the ASSISTANT's changes only.
    const shown = await win.getByTestId("ai-suggested").innerText();
    const aiCount = await win.evaluate(() =>
      (window as unknown as { __likeofficeApi: { revisionCount(a?: string): number } })
        .__likeofficeApi.revisionCount("AI"),
    );
    expect(shown).toContain(String(aiCount));

    await win.getByRole("button", { name: "Reject all" }).click();

    // The assistant's are gone; Dana's are all still there.
    await expect
      .poll(async () =>
        win.evaluate(() =>
          (window as unknown as { __likeofficeApi: { revisionCount(a?: string): number } })
            .__likeofficeApi.revisionCount("AI"),
        ),
      )
      .toBe(0);
    const danaAfter = await win.evaluate(() =>
      (window as unknown as { __likeofficeApi: { revisionCount(a?: string): number } })
        .__likeofficeApi.revisionCount("Dana"),
    );
    expect(danaAfter).toBe(danaBefore);
  } finally {
    app.process().kill("SIGKILL");
  }
});
