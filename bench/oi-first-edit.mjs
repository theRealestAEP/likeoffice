#!/usr/bin/env node
// What the first word_document_edit of an object-insert run carried.
//
//   node bench/oi-first-edit.mjs <batch-name> [<batch-name> ...]
//
// object-insert is fast when that first transaction carries the chart, the
// text box and the equation together, and slow when it carries the chart alone
// into the document's only paragraph — inserting an object there blocks every
// way the model has of adding a sibling paragraph. So the size of the first
// transaction is the mechanism any tool-payload arm difference on this task has
// to run through, and it is read from the transcripts rather than guessed at.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "results");
const batches = process.argv.slice(2);

const rows = [];
for (const file of fs.readdirSync(dir).sort()) {
  if (!file.endsWith(".json")) continue;
  for (const r of JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")).results ?? []) {
    if (r.task !== "object-insert" || !batches.includes(r.batch)) continue;
    const call = (r.transcript ?? [])
      .filter((entry) => entry.role === "assistant")
      .flatMap((entry) => entry.calls ?? [])
      .find((c) => c.name === "word_document_edit");
    const operations = call ? (JSON.parse(call.input).operations ?? []) : [];
    rows.push({
      batch: r.batch,
      arm: r.arm,
      kinds: operations.map((o) => o.kind),
    });
  }
}

console.log("| batch | arm | n | chart alone | 3+ operations | operations, mean |");
console.log("| --- | --- | --- | --- | --- | --- |");
for (const batch of [...batches, "(pooled)"]) {
  for (const arm of ["full", "defs"]) {
    const group = rows.filter((r) => r.arm === arm && (batch === "(pooled)" || r.batch === batch));
    if (group.length === 0) continue;
    const alone = group.filter((r) => r.kinds.length === 1 && r.kinds[0] === "insertChart").length;
    const three = group.filter((r) => r.kinds.length >= 3).length;
    const mean = group.reduce((a, r) => a + r.kinds.length, 0) / group.length;
    console.log(
      `| ${batch} | ${arm} | ${group.length} | ${alone} (${Math.round((100 * alone) / group.length)}%) | ` +
        `${three} (${Math.round((100 * three) / group.length)}%) | ${mean.toFixed(2)} |`,
    );
  }
}
