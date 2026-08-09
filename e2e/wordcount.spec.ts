import { test, expect, _electron as electron } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const APP_DIR = path.join(__dirname, "../apps/desktop");

async function launch(docPath: string) {
  const userData = await mkdtemp(path.join(tmpdir(), "likeoffice-userdata-"));
  const app = await electron.launch({
    args: [APP_DIR, docPath],
    env: { ...process.env, LIKEOFFICE_USER_DATA: userData },
  });
  const win = await app.firstWindow();
  await expect(win.locator(".dxw-page").first()).toBeAttached({ timeout: 30000 });
  return { app, win };
}

async function launchWithBlankDoc() {
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-wc-"));
  const docPath = path.join(dir, "wordcount.docx");
  await copyFile(path.join(APP_DIR, "resources/blank.docx"), docPath);
  return launch(docPath);
}

async function closeApp(app: Awaited<ReturnType<typeof launch>>["app"]) {
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy();
  });
  await app.close();
}

test("engine path: wordCount() statistics drive the pill and popover", async () => {
  const { app, win } = await launchWithBlankDoc();
  const counter = win.locator('[data-testid="word-count"]');
  await expect(counter).toHaveText("0 words", { timeout: 15000 });

  // This engine build carries wordCount(); the pill must consume its
  // statistics OBJECT (the "NaN words" P0 was Number(object) coercion).
  const hasEngineCount = await win.evaluate(
    () =>
      typeof (window as unknown as { __likeofficeApi: { wordCount?: unknown } }).__likeofficeApi
        .wordCount === "function",
  );
  expect(hasEngineCount).toBe(true);

  await win.locator(".dxw-page").first().click();
  await win.keyboard.type("one two three");
  await expect(counter).toHaveText("3 words", { timeout: 15000 });

  await counter.click();
  const popover = win.locator('[data-testid="word-count-popover"]');
  await expect(popover).toBeVisible();
  const rows = await popover.locator(".word-count-row").allTextContents();
  expect(rows).toEqual(["Pages1", "Words3", "Characters13", "Paragraphs1"]);
  await counter.click();
  await expect(popover).toHaveCount(0);

  await closeApp(app);
});

test("fallback path: an engine build without wordCount() still counts", async () => {
  const { app, win } = await launchWithBlankDoc();
  const counter = win.locator('[data-testid="word-count"]');
  await expect(counter).toHaveText("0 words", { timeout: 15000 });

  // Simulate an older engine: remove the API from the live handle.
  await win.evaluate(() => {
    delete (window as unknown as { __likeofficeApi: { wordCount?: unknown } }).__likeofficeApi
      .wordCount;
  });
  await win.locator(".dxw-page").first().click();
  await win.keyboard.type("one two three");
  await expect(counter).toHaveText("3 words", { timeout: 15000 });

  await counter.click();
  const rows = await win
    .locator('[data-testid="word-count-popover"] .word-count-row')
    .allTextContents();
  expect(rows).toEqual(["Pages1", "Words3", "Characters13", "Paragraphs1"]);

  await closeApp(app);
});

/**
 * Regression for the P0 "NaN words" report: an AI-drafted document with line
 * numbering on, tracked insertions (then accepted), and a PAGE field in the
 * footer. The pill must always show a number, never NaN.
 */
test("a document with line numbering, tracked changes and footer fields never shows NaN", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "likeoffice-wc-legal-"));
  const build = path.join(dir, "build");
  await mkdir(path.join(build, "_rels"), { recursive: true });
  await mkdir(path.join(build, "word", "_rels"), { recursive: true });

  const w = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const r = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  await writeFile(
    path.join(build, "[Content_Types].xml"),
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`,
  );
  await writeFile(
    path.join(build, "_rels", ".rels"),
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  await writeFile(
    path.join(build, "word", "_rels", "document.xml.rels"),
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`,
  );
  await writeFile(
    path.join(build, "word", "styles.xml"),
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${w}></w:styles>`,
  );
  // Footer: "Page {PAGE}" — footer text must not count (body-only scope).
  await writeFile(
    path.join(build, "word", "footer1.xml"),
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${w}><w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`,
  );
  // Body: a plain claim (5 words) + a paragraph whose second half is a
  // tracked insertion (2 + 4 words), line numbering on in sectPr.
  await writeFile(
    path.join(build, "word", "document.xml"),
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${w} ${r}><w:body><w:p><w:r><w:t>Plaintiff alleges the following claims.</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Count One.</w:t></w:r><w:ins w:id="1" w:author="Claude" w:date="2026-08-04T00:00:00Z"><w:r><w:t xml:space="preserve"> Inserted by tracked review.</w:t></w:r></w:ins></w:p><w:sectPr><w:footerReference w:type="default" r:id="rId2"/><w:lnNumType w:countBy="1" w:restart="newPage"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
  );
  const docPath = path.join(dir, "complaint.docx");
  execFileSync("zip", ["-X", "-r", docPath, "."], { cwd: build });

  const { app, win } = await launch(docPath);
  const counter = win.locator('[data-testid="word-count"]');
  const numberPill = /^\d[\d,]* words?$/;

  // 5 + 2 + 4 body words; footer "Page 1" excluded.
  await expect(counter).toHaveText("11 words", { timeout: 15000 });

  // Accept the tracked insertion; the count stays a number.
  await win.evaluate(() => {
    (
      window as unknown as { __likeofficeApi: { acceptAllRevisions: () => number } }
    ).__likeofficeApi.acceptAllRevisions();
  });
  await expect(counter).toHaveText("11 words", { timeout: 15000 });
  await expect(counter).toHaveText(numberPill);
  expect(await counter.textContent()).not.toContain("NaN");

  await closeApp(app);
});
