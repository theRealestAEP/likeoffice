#!/usr/bin/env node
// Does the tiered union's escape hatch work?
//
// bench/agent-bench.mjs --tools=menu keeps the create-side operations inline
// and names the adjust-side ones in one open branch, expecting the model to
// call word_document_capabilities when it needs their exact field types. None
// of the three benchmark tasks ever asks for an adjust-side operation, so that
// A/B measures the saving and says nothing about the hatch. This asks for one
// directly, on both payloads, and reports what the model did.
//
//   node bench/menu-escape-probe.mjs [--runs=4] [--tools=defs,menu]
//
// setPageLayout is category "document", so the menu payload names it and its
// field names and nothing else. The full field schema is one
// word_document_capabilities call away, and the system prompt says so.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentDocument, LocalDocumentSession } from "@wordinweb/agent";
import { SYSTEM_PROMPT, MENU_PROMPT_SENTENCE, callModel, readApiKey, toolPayload } from "./agent-bench.mjs";

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const BLANK_DOCX = path.join(path.dirname(BENCH_DIR), "apps/desktop/resources/blank.docx");

const ASK = "Set the page to landscape orientation with 2 inch left and right margins.";
const MAX_ROUNDS = 10;

const runs = Number(process.argv.find((a) => a.startsWith("--runs="))?.split("=")[1] ?? 4);
const arms = (process.argv.find((a) => a.startsWith("--tools="))?.split("=")[1] ?? "defs,menu").split(",");
const model = process.argv.find((a) => a.startsWith("--model="))?.split("=")[1] ?? "claude-opus-5";

const apiKey = readApiKey();
const blank = fs.readFileSync(BLANK_DOCX);

for (const arm of arms) {
  for (let run = 1; run <= runs; run++) {
    const agentDoc = AgentDocument.connect(new LocalDocumentSession(new Uint8Array(blank)), {
      provenance: { author: "AI" },
    });
    const tools = agentDoc.tools();
    const definitions = toolPayload(tools, arm);
    const messages = [{ role: "user", content: ASK }];
    const asked = [];
    const kinds = [];
    const errors = [];
    let rounds = 0;
    for (; rounds < MAX_ROUNDS; rounds++) {
      const reply = await callModel(apiKey, {
        model,
        system: arm === "menu" ? `${SYSTEM_PROMPT}\n${MENU_PROMPT_SENTENCE}` : SYSTEM_PROMPT,
        messages,
        tools: definitions,
      });
      messages.push({ role: "assistant", content: reply.content });
      const calls = reply.content.filter((b) => b.type === "tool_use");
      if (calls.length === 0) {
        rounds++;
        break;
      }
      const results = [];
      for (const call of calls) {
        asked.push(call.name);
        for (const op of call.input?.operations ?? []) kinds.push(op.kind);
        try {
          const output = await tools.find((t) => t.name === call.name).execute(call.input);
          results.push({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(output) });
        } catch (error) {
          errors.push(String(error instanceof Error ? error.message : error));
          results.push({ type: "tool_result", tool_use_id: call.id, content: String(error), is_error: true });
        }
      }
      messages.push({ role: "user", content: results });
    }
    const applied = agentDoc.inspect({ kind: "spatial", pages: { start: 1, count: 1 } });
    const page = applied.pages?.[0];
    console.log(
      `${arm.padEnd(5)} run ${run}  rounds ${rounds}  tools [${asked.join(", ")}]` +
        `  ops [${kinds.join(", ")}]  errors ${errors.length}` +
        `${errors.length ? ` :: ${errors[0].split("\n")[0].slice(0, 100)}` : ""}` +
        `  landscape ${page ? page.width > page.height : "?"}`,
    );
  }
}
