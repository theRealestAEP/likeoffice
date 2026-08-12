#!/usr/bin/env node
// Aggregate an interleaved A/B into one table, arm by arm and task by task.
//
//   node bench/ab-report.mjs 2026-08-12T08-11 2026-08-12T09-99
//
// The two arguments bound the results-file names to one experiment. Each
// results file records its own arm, so the mapping does not depend on the
// order the files were written in.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "results");
const [from = "", to = "￿"] = process.argv.slice(2);

const runs = [];
for (const file of fs.readdirSync(dir).sort()) {
  if (!file.endsWith(".json")) continue;
  const stamp = file.replace(/\.json$/, "");
  if (stamp < from || stamp > to) continue;
  const json = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  for (const r of json.results ?? []) runs.push({ stamp, ...r });
}

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

const tasks = [...new Set(runs.map((r) => r.task))];
const arms = [...new Set(runs.map((r) => r.arm))];

console.log(`runs: ${runs.length}   arms: ${arms.join(", ")}   cache: ${runs[0]?.cache ?? false}`);
for (const arm of arms) {
  const chars = [...new Set(runs.filter((r) => r.arm === arm).map((r) => r.toolPayloadChars))];
  console.log(`  ${arm}: tool payload ${chars.join("/")} chars`);
}
console.log("");
console.log("| task | arm | n | pass | rounds median (range) | input tok median (range) | cache read median | ms median (range) | tool errs |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const task of tasks) {
  for (const arm of arms) {
    const rows = runs.filter((r) => r.task === task && r.arm === arm);
    if (rows.length === 0) continue;
    const cell = (pick) => {
      const v = rows.map(pick);
      return `${median(v)} (${Math.min(...v)}-${Math.max(...v)})`;
    };
    console.log(
      `| ${task} | ${arm} | ${rows.length} | ${rows.filter((r) => r.pass).length}/${rows.length}` +
        ` | ${cell((r) => r.rounds)} | ${cell((r) => r.tokens.input)}` +
        ` | ${median(rows.map((r) => r.tokens.cacheRead))} | ${cell((r) => r.wallMs)}` +
        ` | ${rows.reduce((a, r) => a + r.toolErrors.length, 0)} |`,
    );
  }
}

// Per-round input is the number the tool payload actually moves; total input
// is rounds x per-round and so carries this task's round variance with it.
console.log("");
console.log("| task | arm | input tokens per round, median of per-call values |");
console.log("| --- | --- | --- |");
for (const task of tasks) {
  for (const arm of arms) {
    const rows = runs.filter((r) => r.task === task && r.arm === arm);
    if (rows.length === 0) continue;
    const perCall = rows.flatMap((r) => r.apiCalls.map((c) => c.inputTokens));
    console.log(`| ${task} | ${arm} | ${median(perCall)} (n=${perCall.length}) |`);
  }
}
