#!/usr/bin/env node
// Agent editing-speed benchmark for LikeOffice.
//
// Headless (no Electron): drives the same agentic loop the app's AI panel
// uses — LocalDocumentSession + AgentDocument tools against the real
// Anthropic Messages API — then asserts on the final saved bytes.
//
// Usage:
//   nice -n 19 node bench/agent-bench.mjs [--model=claude-opus-5] [--task=name,name]
//
// The loop, system prompt, MAX_ROUNDS, suggest-flag injection, and request
// shape mirror apps/desktop/src/renderer/src/AiPanel.tsx and
// apps/desktop/src/main/model.ts. Keep them in sync when the app changes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentDocument, LocalDocumentSession } from "@wordinweb/agent";
import { acceptAllBytes, buildFillerBytes, makeView, tasks } from "./tasks.mjs";

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(BENCH_DIR);
const BLANK_DOCX = path.join(REPO_ROOT, "apps/desktop/resources/blank.docx");

const MAX_ROUNDS = 30; // mirrors AiPanel.tsx

// Verbatim from AiPanel.tsx.
const SYSTEM_PROMPT = `You edit the Word document the user has open in LikeOffice.

Inspect before you edit: read the relevant part of the document so your edits
address what is actually there. For bulk text work use word_document_project to
read a window of the document and word_document_patch to rewrite lines in it;
use word_document_edit for targeted structural or formatting changes.

Every edit you make is recorded as a tracked change for the user to accept or
reject, so make the change rather than describing what they should type.

Keep replies short — a sentence or two on what you changed.`;

/** Mirrors AiPanel.tsx withSuggestions: ask the engine to record this call's
 * edits as tracked changes. */
function withSuggestions(name, input) {
  const value = input ?? {};
  if (name === "word_document_patch") return { ...value, suggest: true };
  if (name !== "word_document_edit") return input;
  const operations = Array.isArray(value.operations) ? value.operations : [];
  return {
    ...value,
    operations: operations.map((op) =>
      op?.kind === "insertText" || op?.kind === "splitParagraph"
        ? { ...op, suggest: true }
        : op,
    ),
  };
}

// --- API key (never printed) ----------------------------------------------

function readApiKey() {
  const envPath = path.join(REPO_ROOT, ".env");
  const text = fs.readFileSync(envPath, "utf8");
  for (const name of ["ANTHROPIC", "ANTHROPIC_API_KEY"]) {
    const match = text.match(new RegExp(`^${name}=(.*)$`, "m"));
    if (match) {
      const value = match[1].trim().replace(/^["']|["']$/g, "");
      if (value !== "") return value;
    }
  }
  throw new Error("No ANTHROPIC / ANTHROPIC_API_KEY value found in .env");
}

// --- Messages API (request shape mirrors model.ts; raw fetch, no SDK) ------

async function callModel(apiKey, request) {
  const RETRYABLE = new Set([429, 500, 529]);
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    let response;
    try {
      response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: request.model,
          max_tokens: 16000, // mirrors model.ts
          system: request.system,
          messages: request.messages,
          tools: request.tools,
        }),
      });
    } catch (error) {
      // Network-level failure (no HTTP response). Retry like the SDK would.
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 5000));
        continue;
      }
      throw error;
    }
    if (!response.ok) {
      const body = await response.text();
      let message = body.slice(0, 400);
      try {
        message = JSON.parse(body)?.error?.message ?? message;
      } catch {}
      if (RETRYABLE.has(response.status) && attempt < 3) {
        const retryAfter = Number(response.headers.get("retry-after")) || 2 ** attempt * 5;
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }
      throw new Error(`API ${response.status}: ${message}`);
    }
    const json = await response.json();
    return {
      ms: Date.now() - started,
      content: json.content,
      stopReason: json.stop_reason,
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
    };
  }
}

// --- One task --------------------------------------------------------------

async function runTask(task, { apiKey, model, blankBytes }) {
  const metrics = {
    task: task.name,
    model,
    pass: false,
    wallMs: 0,
    rounds: 0,
    stopReason: null,
    apiCalls: [],
    toolCalls: {},
    toolErrors: [],
    tokens: { input: 0, output: 0 },
    savedValid: false,
    failures: [],
  };

  const fixtureBytes =
    task.fixture === "filler" ? await buildFillerBytes(blankBytes) : blankBytes;
  const session = new LocalDocumentSession(fixtureBytes);
  const agentDoc = AgentDocument.connect(session, { provenance: { author: "AI" } });
  const tools = agentDoc.tools();
  const definitions = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));

  const messages = [{ role: "user", content: task.prompt }];
  const started = Date.now();

  try {
    let round = 0;
    for (; round < MAX_ROUNDS; round++) {
      const reply = await callModel(apiKey, {
        model,
        system: SYSTEM_PROMPT,
        messages,
        tools: definitions,
      });
      metrics.apiCalls.push({
        ms: reply.ms,
        inputTokens: reply.inputTokens,
        outputTokens: reply.outputTokens,
        stopReason: reply.stopReason,
      });
      metrics.tokens.input += reply.inputTokens;
      metrics.tokens.output += reply.outputTokens;
      metrics.stopReason = reply.stopReason;

      messages.push({ role: "assistant", content: reply.content });
      const calls = reply.content.filter((b) => b.type === "tool_use");
      if (calls.length === 0) {
        round++;
        break;
      }

      const results = [];
      for (const call of calls) {
        metrics.toolCalls[call.name] = (metrics.toolCalls[call.name] ?? 0) + 1;
        const tool = tools.find((t) => t.name === call.name);
        if (!tool) {
          metrics.toolErrors.push({ name: call.name, message: "unknown tool" });
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: `Unknown tool ${call.name}`,
            is_error: true,
          });
          continue;
        }
        try {
          const output = await tool.execute(withSuggestions(call.name, call.input));
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: JSON.stringify(output),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          metrics.toolErrors.push({ name: call.name, message });
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: message,
            is_error: true,
          });
        }
      }
      messages.push({ role: "user", content: results });
    }
    metrics.rounds = round;
    if (round >= MAX_ROUNDS) {
      metrics.failures.push(`stopped after ${MAX_ROUNDS} tool rounds`);
    }
  } catch (error) {
    metrics.failures.push(error instanceof Error ? error.message : String(error));
  }
  metrics.wallMs = Date.now() - started;

  // Final saved bytes → reload → assert.
  let final = null;
  let accepted = null;
  try {
    const saved = agentDoc.save();
    final = makeView(saved);
    metrics.savedValid = true;
    try {
      accepted = makeView(acceptAllBytes(saved));
    } catch (error) {
      metrics.failures.push(
        `accept-all pass failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  } catch (error) {
    metrics.failures.push(
      `saved bytes invalid: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (final) metrics.failures.push(...task.assert({ final, accepted }));
  metrics.pass = metrics.failures.length === 0;
  return metrics;
}

// --- Reporting -------------------------------------------------------------

function summaryTable(results) {
  const headers = ["task", "pass", "ms", "rounds", "api calls", "in tok", "out tok", "tool errs"];
  const rows = results.map((r) => [
    r.task,
    r.pass ? "PASS" : "FAIL",
    String(r.wallMs),
    String(r.rounds),
    String(r.apiCalls.length),
    String(r.tokens.input),
    String(r.tokens.output),
    String(r.toolErrors.length),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

// --- Main ------------------------------------------------------------------

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const model = typeof args.model === "string" ? args.model : "claude-opus-5";
const selected =
  typeof args.task === "string"
    ? tasks.filter((t) => args.task.split(",").includes(t.name))
    : tasks;
if (selected.length === 0) {
  console.error(`No matching tasks. Available: ${tasks.map((t) => t.name).join(", ")}`);
  process.exit(2);
}

const apiKey = readApiKey();
const blankBytes = fs.readFileSync(BLANK_DOCX);
const startedAt = new Date();
const results = [];

for (const task of selected) {
  process.stdout.write(`running ${task.name} ... `);
  const result = await runTask(task, { apiKey, model, blankBytes });
  results.push(result);
  console.log(
    `${result.pass ? "PASS" : "FAIL"} (${result.wallMs} ms, ${result.rounds} rounds)`,
  );
}

// Results file + history.
const resultsDir = path.join(BENCH_DIR, "results");
fs.mkdirSync(resultsDir, { recursive: true });
const stamp = startedAt.toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
const resultsPath = path.join(resultsDir, `${stamp}.json`);
fs.writeFileSync(
  resultsPath,
  JSON.stringify({ startedAt: startedAt.toISOString(), model, results }, null, 2),
);
const historyPath = path.join(BENCH_DIR, "history.jsonl");
for (const r of results) {
  fs.appendFileSync(
    historyPath,
    JSON.stringify({
      ts: startedAt.toISOString(),
      task: r.task,
      model,
      ms: r.wallMs,
      rounds: r.rounds,
      inputTokens: r.tokens.input,
      outputTokens: r.tokens.output,
      pass: r.pass,
    }) + "\n",
  );
}

console.log("\n" + summaryTable(results));
for (const r of results) {
  if (r.failures.length > 0) {
    console.log(`\n${r.task} failures:`);
    for (const f of r.failures) console.log(`  - ${f}`);
  }
}
console.log(`\nresults: ${path.relative(REPO_ROOT, resultsPath)}`);

process.exit(results.every((r) => r.pass) ? 0 : 1);
