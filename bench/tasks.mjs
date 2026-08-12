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

/** The filler document with Word's three-column footer line already in place:
 * company, title, and a live page field, two tabs between them. The document
 * class the non-body story projection exists for. */
export async function buildFooterPageBytes(blankBytes) {
  const session = new LocalDocumentSession(await buildFillerBytes(blankBytes));
  const doc = AgentDocument.connect(session, { provenance: { author: "fixture" } });
  const edit = doc.tools().find((t) => t.name === "word_document_edit");
  const result = await edit.execute({
    revision: doc.revision,
    operations: [{ kind: "insertHeaderFooterPreset", hfKind: "footer", preset: "threeColumn" }],
  });
  if (result?.error) throw new Error(`fixture authoring failed: ${result.error}`);
  return doc.save();
}

function headerFooterParts(doc) {
  return doc.pkg.names().filter((name) => /^word\/(header|footer)\d*\.xml$/.test(name));
}

/** PAGE fields anywhere in the package: simple fields carry the instruction in
 * w:instr, complex fields in w:instrText. NUMPAGES does not match. Both the
 * engine's own inserts and Word's write the instruction as one string. */
function countPageFields(doc) {
  let count = 0;
  for (const name of ["word/document.xml", ...headerFooterParts(doc)]) {
    const xml = doc.pkg.text(name) ?? "";
    const instructions = [
      ...[...xml.matchAll(/<w:fldSimple[^>]*w:instr="([^"]*)"/g)].map((m) => m[1]),
      ...[...xml.matchAll(/<w:instrText[^>]*>([^<]*)<\/w:instrText>/g)].map((m) => m[1]),
    ];
    count += instructions.filter((instruction) => /\bPAGE\b/.test(instruction)).length;
  }
  return count;
}

/** Tab characters in the header/footer parts — the bare `<w:tab/>` of a run,
 * not the attributed `<w:tab w:val=…/>` of a tab stop. The page-number gallery
 * replaces a footer's entire content, so the fixture's two tabs survive only
 * if the model left the existing footer line alone. */
function countHeaderFooterTabs(doc) {
  return headerFooterParts(doc)
    .map((name) => (doc.pkg.text(name) ?? "").match(/<w:tab\s*\/>/g)?.length ?? 0)
    .reduce((total, tabs) => total + tabs, 0);
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
  {
    // The footer already holds a page number. The projection shows it, so the
    // model must recognize it rather than add a second one — or wipe the
    // footer by running the page-number gallery over it blind.
    name: "footer-page-number",
    fixture: "footer-page",
    prompt: "add page numbers",
    assert({ final }) {
      const failures = [];
      const fields = countPageFields(final.doc);
      if (fields !== 1) failures.push(`expected exactly 1 PAGE field, got ${fields}`);
      const tabs = countHeaderFooterTabs(final.doc);
      if (tabs !== 2) {
        failures.push(`the existing footer line was replaced (${tabs} tab characters, want 2)`);
      }
      return failures;
    },
  },
  {
    // Object insertion: chart + text box + display equation. Target: <=4 rounds.
    name: "object-insert",
    fixture: "blank",
    prompt:
      "Add a column chart of quarterly revenue (Q1: 10, Q2: 12, Q3: 9, Q4: 15) titled Revenue, then a text box that says Draft — internal only, then the quadratic formula as a display equation.",
    assert({ final }) {
      const failures = [];

      // (1) Chart part with the right data. The chart lives in its own package
      // part (word/charts/chartN.xml), reachable through the reloaded
      // document's pkg; its writer caches every category/value as
      // <c:pt><c:v>...</c:v></c:pt>, so string checks on the part are exact.
      const chartParts = final.doc.pkg
        .names()
        .filter((n) => /^word\/charts\/chart\d*\.xml$/.test(n));
      if (chartParts.length !== 1) {
        failures.push(`expected exactly 1 chart part, got ${chartParts.length}`);
      } else {
        const xml = final.doc.pkg.text(chartParts[0]) ?? "";
        const cat = xml.match(/<c:cat>([\s\S]*?)<\/c:cat>/);
        const catCount = cat ? (cat[1].match(/<c:pt\b/g) ?? []).length : 0;
        if (catCount !== 4) {
          failures.push(`chart: expected 4 category literals, got ${catCount}`);
        }
        const val = xml.match(/<c:val>([\s\S]*?)<\/c:val>/);
        const values = val
          ? [...val[1].matchAll(/<c:v>([^<]*)<\/c:v>/g)].map((m) => Number(m[1]))
          : [];
        if (values.join(",") !== "10,12,9,15") {
          failures.push(
            `chart: expected series values 10,12,9,15, got [${values.join(",")}]`,
          );
        }
        const title = xml.match(/<c:title>[\s\S]*?<\/c:title>/);
        if (!title || !title[0].includes("Revenue")) {
          failures.push('chart: no title containing "Revenue"');
        }
      }

      // (2) A text box whose text mentions Draft. Text boxes serialize as
      // txbxContent (wps and VML fallback alike) inside document.xml.
      const boxes = collect(final.doc.docRoot, "txbxContent");
      if (boxes.length === 0) {
        failures.push("no text box (txbxContent) in the saved document");
      } else if (!boxes.some((box) => /draft/i.test(textOf(box)))) {
        failures.push('no text box whose text contains "Draft"');
      }

      // (3) A display equation.
      if (collect(final.doc.docRoot, "oMath").length === 0) {
        failures.push("no m:oMath region in the saved document");
      }

      return failures;
    },
  },
];
