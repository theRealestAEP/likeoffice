#!/usr/bin/env node
// object-insert rounds, batch by batch, with the within-pair arm order that
// produced them. The point of the split is that an interleaved A/B still has
// a first-and-second position inside each pair, and this task turned out to
// be sensitive to it. Pass batches as "label:arm-first:from:to".
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "results");
const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;

function load(from, to) {
  const out = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) continue;
    const stamp = file.replace(/\.json$/, "");
    if (stamp < from || stamp > to) continue;
    for (const r of JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")).results ?? []) {
      if (r.task === "object-insert") out.push(r);
    }
  }
  return out;
}

const batches = process.argv.slice(2).map((a) => a.split(":"));
const all = [];
console.log("| batch | pair order | arm | n | rounds median | rounds mean | rounds |");
console.log("| --- | --- | --- | --- | --- | --- | --- |");
for (const [label, first, from, to] of batches) {
  const rows = load(from, to);
  all.push(...rows.map((r) => ({ ...r, first })));
  for (const arm of ["full", "defs"]) {
    const rounds = rows.filter((r) => r.arm === arm).map((r) => r.rounds).sort((a, b) => a - b);
    if (rounds.length === 0) continue;
    console.log(
      `| ${label} | ${first} first | ${arm} | ${rounds.length} | ${median(rounds)} | ${mean(rounds).toFixed(1)} | ${rounds.join(", ")} |`,
    );
  }
}

// Mann-Whitney U on rounds, overall and split by which arm ran first.
function compare(label, rows) {
  const D = rows.filter((r) => r.arm === "defs").map((r) => r.rounds);
  const F = rows.filter((r) => r.arm === "full").map((r) => r.rounds);
  if (D.length === 0 || F.length === 0) return;
  let gt = 0;
  let eq = 0;
  for (const d of D) for (const f of F) (d > f ? gt++ : d === f ? eq++ : 0);
  const U = gt + eq / 2;
  const z = (U - (D.length * F.length) / 2) / Math.sqrt((D.length * F.length * (D.length + F.length + 1)) / 12);
  const erf = (x) => {
    const s = Math.sign(x);
    const a = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * a);
    const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
    return s * y;
  };
  console.log(
    `${label}: full n=${F.length} median ${median(F)} mean ${mean(F).toFixed(1)} | ` +
      `defs n=${D.length} median ${median(D)} mean ${mean(D).toFixed(1)} | ` +
      `P(defs>full)=${(U / (D.length * F.length)).toFixed(3)} p~${(2 * (1 - 0.5 * (1 + erf(z / Math.SQRT2)))).toFixed(3)}`,
  );
}
console.log("");
compare("all batches            ", all);
compare("batches with full first", all.filter((r) => r.first === "full"));
compare("batches with defs first", all.filter((r) => r.first === "defs"));
console.log(`pass: ${all.filter((r) => r.pass).length}/${all.length}`);
