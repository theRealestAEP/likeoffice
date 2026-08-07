// Benchmark task definitions and the XML helpers their assertions use.
// Assertions run against the FINAL saved bytes reloaded through DocxDocument
// (the `final` view) and against an accept-all-revisions copy (`accepted`).
import { AgentDocument, LocalDocumentSession } from "@wordinweb/agent";
import { DocxDocument } from "wordinweb";

// --- XML helpers -----------------------------------------------------------

function localName(el) {
  const i = el.name.indexOf(":");
  return i === -1 ? el.name : el.name.slice(i + 1);
}

/** Every descendant (including el) whose local name matches. */
export function collect(el, name, out = []) {
  if (localName(el) === name) out.push(el);
  for (const child of el.children) collect(child, name, out);
  return out;
}

/** Concatenated w:t text. Tracked deletions use w:delText, so this reads as
 * the accepted (final-view) text even on a document full of suggestions. */
export function textOf(el) {
  return collect(el, "t")
    .map((t) => t.text)
    .join("");
}

export function bodyOf(doc) {
  return doc.docRoot.children.find((c) => localName(c) === "body");
}

/** Direct w:p children of the body (top-level paragraphs, not table cells). */
export function bodyParagraphs(doc) {
  return bodyOf(doc).children.filter((c) => localName(c) === "p");
}

function hasNumPr(p) {
  return collect(p, "numPr").length > 0;
}

function isHeadingLike(p) {
  const style = collect(p, "pStyle")[0];
  const styleId = style?.attrs["w:val"] ?? style?.attrs.val ?? "";
  if (/^(Heading|Title)/i.test(styleId)) return true;
  // A bold run inside the paragraph also counts as a "bold heading".
  return collect(p, "r").some((r) =>
    collect(r, "rPr").some((rPr) => collect(rPr, "b").length > 0),
  );
}

/** Build a `final`/`accepted` view pair from saved bytes. Throws if the bytes
 * fail to reload — the harness records that as its own failure. */
export function makeView(bytes) {
  const doc = DocxDocument.load(bytes);
  return { doc, text: textOf(bodyOf(doc)), paragraphs: bodyParagraphs(doc) };
}

/** Reload saved bytes, accept every tracked change, and save again. The
 * intent refuses to apply on a document with no revisions, so skip it then. */
export function acceptAllBytes(bytes) {
  const session = new LocalDocumentSession(bytes);
  const revisions =
    collect(session.doc.docRoot, "ins").length +
    collect(session.doc.docRoot, "del").length;
  if (revisions > 0) session.submit({ kind: "acceptAllRevisions" });
  return session.doc.save();
}

// --- Filler fixture --------------------------------------------------------

export const FILLER_PARAGRAPHS = [
  "Contoso Ltd. opened the fiscal year with a cautious plan and a small, focused team.",
  "The second quarter brought a broad expansion across every region that Contoso served: the field organization doubled its visit cadence, the support desk cleared a backlog that had lingered since winter, marketing shipped three campaigns that each outperformed the internal forecast, and the finance group closed the books early in both months while still finding time to retire two legacy reporting systems.",
  "By December the pace had settled, and Contoso archived the records of the year without ceremony.",
];

/** Author the three-paragraph filler doc from the blank fixture using the
 * agent edit tools directly (no suggestions, no model). */
export async function buildFillerBytes(blankBytes) {
  const session = new LocalDocumentSession(blankBytes);
  const doc = AgentDocument.connect(session, { provenance: { author: "fixture" } });
  const tools = doc.tools();
  const inspect = tools.find((t) => t.name === "word_document_inspect");
  const edit = tools.find((t) => t.name === "word_document_edit");

  for (let i = 0; i < FILLER_PARAGRAPHS.length; i++) {
    const read = await inspect.execute({ kind: "read" });
    const block = read.blocks[read.blocks.length - 1];
    const run = block.runs[block.runs.length - 1];
    const text = FILLER_PARAGRAPHS[i];
    const operations = [
      {
        kind: "insertText",
        at: { blockRef: block.ref, runRef: run.ref, offset: run.paragraphEnd ?? 0 },
        text,
      },
    ];
    if (i < FILLER_PARAGRAPHS.length - 1) {
      operations.push({
        kind: "splitParagraph",
        at: {
          blockRef: block.ref,
          runRef: run.ref,
          offset: (run.paragraphEnd ?? 0) + text.length,
        },
      });
    }
    const result = await edit.execute({ revision: doc.revision, operations });
    if (result?.error) throw new Error(`fixture authoring failed: ${result.error}`);
  }
  return doc.save();
}

// --- Tasks -----------------------------------------------------------------
// assert({final, accepted}) returns an array of failure strings (empty = pass).
// `accepted` is null when the accept-all pass itself failed.

function needAccepted(accepted, failures) {
  if (accepted === null) {
    failures.push("accepted view unavailable (accept-all pass failed)");
    return false;
  }
  return true;
}

export const tasks = [
  {
    name: "declaration-intro",
    fixture: "blank",
    prompt:
      "write the intro to the Declaration of Independence with a bold heading and two body paragraphs",
    assert({ final, accepted }) {
      const failures = [];
      const withText = final.paragraphs.filter((p) => textOf(p).trim() !== "");
      if (withText.length < 3) {
        failures.push(`expected >=3 non-empty paragraphs, got ${withText.length}`);
      }
      if (!withText.some((p) => isHeadingLike(p))) {
        failures.push("no bold or heading-styled paragraph with text found");
      }
      if (!final.text.includes("When in the Course of human events")) {
        failures.push('body text missing "When in the Course of human events"');
      }
      if (!final.text.includes("We hold these truths")) {
        failures.push('body text missing "We hold these truths"');
      }
      if (collect(final.doc.docRoot, "ins").length === 0) {
        failures.push("no tracked changes (w:ins) in the saved document");
      }
      if (needAccepted(accepted, failures)) {
        const leftover =
          collect(accepted.doc.docRoot, "ins").length +
          collect(accepted.doc.docRoot, "del").length;
        if (leftover > 0) {
          failures.push(`accept-all left ${leftover} w:ins/w:del elements behind`);
        }
        if (!accepted.text.includes("We hold these truths")) {
          failures.push("accepted document lost expected body text");
        }
      }
      return failures;
    },
  },
  {
    name: "memo",
    fixture: "blank",
    prompt:
      "Write a short memo titled \"Office Move Update\" with a 4-item bulleted list of action items.",
    assert({ final }) {
      const failures = [];
      if (!final.text.includes("Office Move Update")) {
        failures.push('title "Office Move Update" not found in body text');
      }
      const listParagraphs = final.paragraphs.filter(
        (p) => hasNumPr(p) && textOf(p).trim() !== "",
      );
      if (listParagraphs.length < 4) {
        failures.push(
          `expected >=4 list paragraphs with numbering props, got ${listParagraphs.length}`,
        );
      }
      return failures;
    },
  },
  {
    name: "table-report",
    fixture: "blank",
    prompt: "create a 3-column, 4-row table of quarterly sales with a header row",
    assert({ final }) {
      const failures = [];
      const tables = bodyOf(final.doc).children.filter((c) => localName(c) === "tbl");
      if (tables.length !== 1) {
        failures.push(`expected exactly 1 table, got ${tables.length}`);
        return failures;
      }
      const rows = tables[0].children.filter((c) => localName(c) === "tr");
      if (rows.length !== 4) failures.push(`expected 4 rows, got ${rows.length}`);
      rows.forEach((row, i) => {
        const cells = row.children.filter((c) => localName(c) === "tc");
        if (cells.length !== 3) {
          failures.push(`row ${i + 1}: expected 3 cells, got ${cells.length}`);
        }
      });
      const header = rows[0];
      if (header) {
        const cells = header.children.filter((c) => localName(c) === "tc");
        if (!cells.length || cells.some((c) => textOf(c).trim() === "")) {
          failures.push("header row has empty cells");
        }
      }
      return failures;
    },
  },
  {
    name: "rewrite",
    fixture: "filler",
    prompt:
      "Rewrite the second paragraph to half its length. Do not change the other paragraphs.",
    assert({ accepted }) {
      const failures = [];
      if (!needAccepted(accepted, failures)) return failures;
      const texts = accepted.paragraphs.map((p) => textOf(p));
      if (texts.length !== FILLER_PARAGRAPHS.length) {
        failures.push(
          `paragraph count changed: expected ${FILLER_PARAGRAPHS.length}, got ${texts.length}`,
        );
        return failures;
      }
      if (texts[0] !== FILLER_PARAGRAPHS[0]) failures.push("first paragraph text changed");
      if (texts[2] !== FILLER_PARAGRAPHS[2]) failures.push("third paragraph text changed");
      if (texts[1].trim() === "") failures.push("second paragraph is empty");
      else if (texts[1].length >= FILLER_PARAGRAPHS[1].length) {
        failures.push(
          `second paragraph did not get shorter (${texts[1].length} >= ${FILLER_PARAGRAPHS[1].length} chars)`,
        );
      }
      return failures;
    },
  },
  {
    name: "bulk-text",
    fixture: "filler",
    prompt:
      'Replace every occurrence of "Contoso" with "Fabrikam" throughout the document. Do not change anything else.',
    assert({ accepted }) {
      const failures = [];
      if (!needAccepted(accepted, failures)) return failures;
      const texts = accepted.paragraphs.map((p) => textOf(p));
      const expected = FILLER_PARAGRAPHS.map((p) => p.replaceAll("Contoso", "Fabrikam"));
      if (texts.length !== expected.length) {
        failures.push(
          `paragraph count changed: expected ${expected.length}, got ${texts.length}`,
        );
        return failures;
      }
      expected.forEach((want, i) => {
        if (texts[i] !== want) {
          failures.push(
            `paragraph ${i + 1} drifted: expected ${JSON.stringify(want.slice(0, 60))}..., got ${JSON.stringify(texts[i].slice(0, 60))}...`,
          );
        }
      });
      if (accepted.text.includes("Contoso")) {
        failures.push('"Contoso" still present after replacement');
      }
      return failures;
    },
  },
];
