// Byte-parity check for the orphan-chart-part release.
//
// Run it twice — once resolving @wordinweb/agent to the engine build WITHOUT
// the change, once WITH it — and compare the digests. Every document that
// holds no orphan chart part must save to identical bytes, which is what makes
// an A/B against the model pointless: the arms cannot differ on those tasks.
import crypto from "node:crypto";
import fs from "node:fs";
import { AgentDocument, LocalDocumentSession } from "@wordinweb/agent";
import { buildFillerBytes, buildFooterPageBytes } from "./tasks.mjs";

const BLANK = "/Users/alexpickett/Desktop/Projects/likeoffice/apps/desktop/resources/blank.docx";
const blank = fs.readFileSync(BLANK);
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);

const CHART = {
  kind: "insertChart",
  chart: {
    type: "column",
    title: "Revenue",
    categories: ["Q1", "Q2", "Q3", "Q4"],
    series: [{ name: "Revenue", values: [10, 12, 9, 15] }],
  },
};

async function connected(bytes) {
  const session = new LocalDocumentSession(bytes);
  return AgentDocument.connect(session, { provenance: { author: "AI" } });
}

async function anchorRun(doc) {
  const read = await doc.inspect({ kind: "read" });
  return read.blocks[0].runs[0].ref;
}

const cases = {
  async blank() {
    return (await connected(blank)).save();
  },
  async filler() {
    return (await connected(await buildFillerBytes(blank))).save();
  },
  async "footer-page"() {
    return (await connected(await buildFooterPageBytes(blank))).save();
  },
  async "live chart"() {
    const doc = await connected(blank);
    await doc.edit({ revision: doc.revision, operations: [{ ...CHART, runRef: await anchorRun(doc) }] });
    return doc.save();
  },
  async "deleted chart"() {
    const doc = await connected(blank);
    await doc.edit({ revision: doc.revision, operations: [{ ...CHART, runRef: await anchorRun(doc) }] });
    const read = await doc.inspect({ kind: "read" });
    const ref = read.blocks
      .flatMap((b) => b.runs ?? [])
      .flatMap((r) => r.components ?? [])
      .find((c) => c.type === "chart").editRef;
    await doc.edit({ revision: doc.revision, operations: [{ kind: "removeDrawing", objectRef: ref }] });
    return doc.save();
  },
};

for (const [name, run] of Object.entries(cases)) {
  console.log(`${name.padEnd(14)} ${sha(await run())}`);
}
