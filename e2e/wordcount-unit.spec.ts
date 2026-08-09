import { test, expect } from "@playwright/test";
import { computeStats, fmt } from "../apps/desktop/src/renderer/src/WordCount";
import type { DocxViewApi } from "wordinweb";

/**
 * Unit tests for the pill's statistics function. The engine's wordCount()
 * returns a TextStatistics OBJECT — the P0 "NaN words" bug was the pill
 * coercing that object with Number(). These tests pin both paths: the engine
 * object path and the duck-typed fallback walk over the document model.
 */

const asApi = (stub: object): DocxViewApi => stub as unknown as DocxViewApi;

test("engine path: the wordCount() object maps onto the pill's stats", () => {
  const api = asApi({
    wordCount: () => ({
      words: 4242,
      characters: 20000,
      charactersWithSpaces: 24242,
      paragraphs: 99,
      pages: 12,
    }),
  });
  expect(computeStats(api)).toEqual({ words: 4242, characters: 24242, paragraphs: 99, pages: 12 });
});

test("fallback path: sections, tables, fields, tracked-hidden content", () => {
  const text = (t: string) => ({ type: "run", content: [{ kind: "text", text: t }] });
  const doc = {
    sections: [
      {
        blocks: [
          { type: "paragraph", children: [text("Plaintiff alleges four claims.")] },
          // A field contributes its cached result text, like Word.
          {
            type: "paragraph",
            children: [
              text("See page "),
              { type: "run", content: [{ kind: "field", cachedResult: "12" }] },
            ],
          },
          // A rejected tracked insertion is hidden and must not count.
          { type: "paragraph", revisionHidden: true, children: [text("hidden words here")] },
          // A hyperlink-style child wraps its runs.
          {
            type: "paragraph",
            children: [{ type: "hyperlink", runs: [text("linked words")] }],
          },
          // Empty paragraph: no words, not a counted paragraph.
          { type: "paragraph", children: [] },
          {
            type: "table",
            rows: [{ cells: [{ blocks: [{ type: "paragraph", children: [text("cell text")] }] }] }],
          },
        ],
      },
      { blocks: [{ type: "paragraph", children: [text("second section")] }] },
    ],
    pageCount: 3,
  };
  const api = asApi({ document: doc, pageCount: () => 3 });
  const stats = computeStats(api);
  // "Plaintiff alleges four claims." (4) + "See page 12" (3) +
  // "linked words" (2) + "cell text" (2) + "second section" (2)
  expect(stats.words).toBe(13);
  expect(stats.paragraphs).toBe(5);
  expect(stats.pages).toBe(3);
  expect(Number.isFinite(stats.characters)).toBe(true);
});

test("every stat is finite on both paths — the NaN regression", () => {
  const engine = computeStats(
    asApi({ wordCount: () => ({ words: 0, characters: 0, charactersWithSpaces: 0, paragraphs: 0, pages: 1 }) }),
  );
  const fallback = computeStats(asApi({ document: { sections: [] }, pageCount: () => 1 }));
  for (const stats of [engine, fallback]) {
    for (const value of Object.values(stats)) expect(Number.isFinite(value)).toBe(true);
  }
});

test("fmt guards non-finite values with a dash, never NaN", () => {
  expect(fmt(1234567)).toBe("1,234,567");
  expect(fmt(0)).toBe("0");
  expect(fmt(Number.NaN)).toBe("—");
  expect(fmt(Number.POSITIVE_INFINITY)).toBe("—");
});
