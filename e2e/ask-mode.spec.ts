import { test, expect, _electron as electron } from "@playwright/test";
import { copyFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

/**
 * Ask mode has to WITHHOLD the editing tools, not merely discourage them.
 *
 * A system prompt saying "please don't edit" is a request the model can ignore
 * — and one a prompt injection hidden in the document or a fetched page can
 * talk it out of. The assertion is therefore about the TOOL LIST that leaves
 * the app, and about the document being untouched afterwards.
 *
 * The fake model always tries to edit (see main/model.ts), which makes it the
 * perfect adversary here: in Ask mode it must fail to change anything.
 */
test("Ask mode sends no writing tools and leaves the document alone", async () => {
  test.setTimeout(180000);
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-ask-"));
  const docPath = path.join(dir, "ask.docx");
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
    await win.locator(".dxw-page").first().click();
    await win.keyboard.type("Hello world.");
    const before = await win.evaluate(
      () => (window as unknown as { __likeofficeApi: { save(): Uint8Array } }).__likeofficeApi.save().length,
    );

    await win.getByTestId("ai-toggle").click();
    await win.getByTestId("ai-mode-ask").click();
    await expect(win.getByTestId("ai-mode-ask")).toHaveAttribute("aria-checked", "true");

    // Record the tool names that actually reach the model.
    await win.getByTestId("ai-input").fill("Make the first sentence bold.");
    await win.getByTestId("ai-input").press("Enter");

    // POLL, do not assert-and-hope: "the transcript no longer says Thinking…"
    // is true before the request has even started, so it raced the model call
    // and read the tool list from before the turn.
    await expect
      .poll(
        async () =>
          (
            await app.evaluate(
              () => (globalThis as { __likeofficeLastTools?: string[] }).__likeofficeLastTools ?? [],
            )
          ).length,
        { timeout: 60000 },
      )
      .toBeGreaterThan(0);
    const sentTools = await app.evaluate(
      () => (globalThis as { __likeofficeLastTools?: string[] }).__likeofficeLastTools ?? [],
    );
    for (const writing of [
      "word_document_edit",
      "word_document_patch",
      "word_document_compose",
      "word_document_save",
    ]) {
      expect(sentTools).not.toContain(writing);
    }
    // Reading stays: an answer needs the document.
    expect(sentTools).toContain("word_document_inspect");

    // And nothing changed.
    const after = await win.evaluate(
      () => (window as unknown as { __likeofficeApi: { save(): Uint8Array } }).__likeofficeApi.save().length,
    );
    expect(after).toBe(before);
  } finally {
    app.process().kill("SIGKILL");
  }
});
