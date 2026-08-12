#!/usr/bin/env node
// What the AI panel's tool definitions cost, per tool and in total, for each
// --tools arm. This is the measurement every schema experiment starts from:
// the definitions ship on every request of every round, so their size is the
// per-round floor.
//
//   node bench/tool-payload.mjs            # characters only, no API call
//   node bench/tool-payload.mjs --tokens   # + a live count_tokens per arm
//
// --tokens spends money: one Messages count_tokens call per arm, each carrying
// the whole payload beside a one-word user message.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentDocument, LocalDocumentSession } from "@wordinweb/agent";
import { readApiKey, toolPayload } from "./agent-bench.mjs";

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const BLANK_DOCX = path.join(path.dirname(BENCH_DIR), "apps/desktop/resources/blank.docx");

const ARMS = ["full", "defs", "menu"];

async function countTokens(apiKey, definitions) {
  const response = await fetch("https://api.anthropic.com/v1/messages/count_tokens", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-opus-5",
      messages: [{ role: "user", content: "hi" }],
      tools: definitions,
    }),
  });
  if (!response.ok) throw new Error(`count_tokens ${response.status}: ${await response.text()}`);
  return (await response.json()).input_tokens;
}

const wantTokens = process.argv.includes("--tokens");
const session = new LocalDocumentSession(fs.readFileSync(BLANK_DOCX));
const tools = AgentDocument.connect(session, { provenance: { author: "AI" } }).tools();
const apiKey = wantTokens ? readApiKey() : null;

console.log("| arm | payload chars | edit tool chars | $defs entries | input tokens |");
console.log("| --- | --- | --- | --- | --- |");
for (const arm of ARMS) {
  const definitions = toolPayload(tools, arm);
  const edit = definitions.find((d) => d.name === "word_document_edit");
  const defs = Object.keys(edit.input_schema.$defs ?? {});
  const tokens = apiKey ? await countTokens(apiKey, definitions) : "-";
  console.log(
    `| ${arm} | ${JSON.stringify(definitions).length} | ${JSON.stringify(edit).length} | ${defs.length} | ${tokens} |`,
  );
}

const emitted = toolPayload(tools, "defs").find((d) => d.name === "word_document_edit").input_schema;
console.log(`\n$defs: ${Object.keys(emitted.$defs ?? {}).join(", ")}`);
