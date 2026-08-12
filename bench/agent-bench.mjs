#!/usr/bin/env node
// Agent editing-speed benchmark for LikeOffice.
//
// Headless (no Electron): drives the same agentic loop the app's AI panel
// uses — LocalDocumentSession + AgentDocument tools against the real
// Anthropic Messages API — then asserts on the final saved bytes.
//
// Usage:
//   nice -n 19 node bench/agent-bench.mjs [--model=claude-opus-5] [--task=name,name]
//                                         [--runs=N]
//
// A single run of a task is one sample of a noisy process: the same task can
// take 3 rounds or 14. Use --runs=N (the summary reports the median and the
// range) before drawing any conclusion from a number.
//
// The loop, system prompt, MAX_ROUNDS, suggest-flag injection, and request
// shape mirror apps/desktop/src/renderer/src/AiPanel.tsx and
// apps/desktop/src/main/model.ts. Keep them in sync when the app changes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentDocument, LocalDocumentSession } from "@wordinweb/agent";
import {
  acceptAllBytes,
  buildFillerBytes,
  buildFooterPageBytes,
  makeView,
  tasks,
} from "./tasks.mjs";

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(BENCH_DIR);
const BLANK_DOCX = path.join(REPO_ROOT, "apps/desktop/resources/blank.docx");

const MAX_ROUNDS = 30; // mirrors AiPanel.tsx

// Verbatim from AiPanel.tsx (as of the projection-prefetch overhaul).
const SYSTEM_PROMPT = `You edit the Word document the user has open in LikeOffice.

Each user message opens with a <document> tag: the document body projected as
numbered lines, with the revision it was read at. That is the current
document — do not project or inspect it again. Header, footer, and note
stories with content follow the body as <story> blocks: read them before you
add header, footer, or page-number content, and patch one by passing its ref
as the story and its mode.

For text work — wording, adding, removing, or rewriting text — reply with ONE
word_document_patch call immediately, against those line numbers. Pass the
revision from the tag, story "body", mode "text", and edits of
{ startLine, endLine, newText } that rewrite whole lines.

Use word_document_inspect and word_document_edit only for what the text
projection cannot express: formatting, styles, tables, images, objects, or
document structure. To create a table: ONE word_document_inspect
{ kind: "read" } call for the anchor runRef, then ONE insertTable operation
carrying rows, cols, cells (all cell texts, header row first), and
headerRow: true — never inspect twice or fill cells with separate edits.

If the message notes the projection is truncated, text beyond its window is
reachable with word_document_project and the cursor the note provides.

Every edit you make is recorded as a tracked change for the user to accept or
reject, so make the change rather than describing what they should type.

Keep replies to a sentence.`;

const PROJECTION_MAX_CHARACTERS = 50_000;
const STORY_MAX_CHARACTERS = 2_000;

const PROJECTED_STORY_KINDS = ["header", "footer", "footnote", "endnote"];

function numberLines(text) {
  return text
    .split("\n")
    .map((line, index) => `${index + 1}: ${line}`)
    .join("\n");
}

/** Mirrors AiPanel.tsx storyBlocks: every non-body story that holds content,
 * each as its own tag, projected in md mode so fields read as {{PAGE}}. */
async function storyBlocks(tools, project) {
  const inspect = tools.find((t) => t.name === "word_document_inspect");
  if (!inspect) return "";
  try {
    const overview = await inspect.execute({ kind: "overview" });
    let blocks = "";
    for (const story of overview.stories) {
      if (!PROJECTED_STORY_KINDS.includes(story.kind)) continue;
      const projection = await project.execute({
        story: story.id,
        mode: "md",
        maxCharacters: STORY_MAX_CHARACTERS,
      });
      if (projection.text.trim() === "") continue;
      blocks += `\n<story kind="${story.kind}" ref="${story.id}" mode="md">\n${numberLines(projection.text)}\n</story>`;
    }
    return blocks;
  } catch {
    return "";
  }
}

/** Mirrors AiPanel.tsx projectionMessage: fold the body projection into the
 * first user message so a text-only ask can patch in round one. */
async function projectionMessage(tools, ask) {
  const project = tools.find((t) => t.name === "word_document_project");
  if (!project) return ask;
  try {
    const projection = await project.execute({
      story: "body",
      mode: "text",
      maxCharacters: PROJECTION_MAX_CHARACTERS,
    });
    const numbered = numberLines(projection.text);
    const stories = await storyBlocks(tools, project);
    const note =
      projection.truncated && projection.next
        ? `\n(The projection is truncated. Project further windows with word_document_project and cursor "${projection.next.value}".)`
        : "";
    return `<document story="body" mode="text" revision="${projection.revision}">\n${numbered}${stories}\n</document>${note}\n\n${ask}`;
  } catch {
    return ask;
  }
}

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

// --- Transcript recording ---------------------------------------------------

/** Cap one recorded value so a results file stays readable. Long projections
 * are the only things that reach this; the tail matters less than the head. */
const TRANSCRIPT_MAX_CHARACTERS = 20_000;

function clip(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (typeof text !== "string") return text;
  return text.length <= TRANSCRIPT_MAX_CHARACTERS
    ? text
    : `${text.slice(0, TRANSCRIPT_MAX_CHARACTERS)}…[${text.length - TRANSCRIPT_MAX_CHARACTERS} more characters]`;
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
    // Round-by-round: what the model said, what it asked each tool to do, and
    // what each tool answered. Tool names alone cannot tell you why a run
    // inserted a second chart; the inputs and the results can.
    transcript: [],
  };

  const fixtureBytes =
    task.fixture === "filler"
      ? await buildFillerBytes(blankBytes)
      : task.fixture === "footer-page"
        ? await buildFooterPageBytes(blankBytes)
        : blankBytes;
  const session = new LocalDocumentSession(fixtureBytes);
  const agentDoc = AgentDocument.connect(session, { provenance: { author: "AI" } });
  const tools = agentDoc.tools();
  const definitions = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));

  const firstMessage = await projectionMessage(tools, task.prompt);
  const messages = [{ role: "user", content: firstMessage }];
  metrics.transcript.push({ round: 0, role: "user", text: clip(firstMessage) });
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
      messages.push({ role: "assistant", content: reply.content });
      const calls = reply.content.filter((b) => b.type === "tool_use");
      metrics.apiCalls.push({
        ms: reply.ms,
        inputTokens: reply.inputTokens,
        outputTokens: reply.outputTokens,
        stopReason: reply.stopReason,
        // What the model asked for this round, in order: a slow run is only
        // diagnosable if the round-by-round sequence survives in the JSON.
        tools: calls.map((c) => c.name),
      });
      metrics.tokens.input += reply.inputTokens;
      metrics.tokens.output += reply.outputTokens;
      metrics.stopReason = reply.stopReason;
      metrics.transcript.push({
        round: round + 1,
        role: "assistant",
        text: reply.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n"),
        calls: calls.map((c) => ({ id: c.id, name: c.name, input: clip(c.input) })),
      });

      if (calls.length === 0) {
        round++;
        break;
      }

      const results = [];
      const observed = [];
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
          observed.push({ id: call.id, name: call.name, error: "unknown tool" });
          continue;
        }
        // The harness injects suggest, so the tool sees different input than
        // the model wrote. Record what the tool actually ran.
        const effective = withSuggestions(call.name, call.input);
        try {
          const output = await tool.execute(effective);
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: JSON.stringify(output),
          });
          observed.push({ id: call.id, name: call.name, sent: clip(effective), result: clip(output) });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          metrics.toolErrors.push({ name: call.name, message });
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: message,
            is_error: true,
          });
          observed.push({ id: call.id, name: call.name, sent: clip(effective), error: clip(message) });
        }
      }
      metrics.transcript.push({ round: round + 1, role: "tool_results", results: observed });
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

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** One row per task. Each cell is the median across that task's runs, with the
 * range in parentheses when the task ran more than once. */
function summaryTable(results) {
  const headers = ["task", "pass", "ms", "rounds", "api calls", "in tok", "out tok", "tool errs"];
  const byTask = new Map();
  for (const r of results) {
    if (!byTask.has(r.task)) byTask.set(r.task, []);
    byTask.get(r.task).push(r);
  }
  const rows = [...byTask].map(([task, runs]) => {
    const stat = (pick) => {
      const values = runs.map(pick);
      const middle = String(median(values));
      if (runs.length === 1) return middle;
      return `${middle} (${Math.min(...values)}-${Math.max(...values)})`;
    };
    const passed = runs.filter((r) => r.pass).length;
    return [
      task,
      passed === runs.length ? "PASS" : `FAIL ${passed}/${runs.length}`,
      stat((r) => r.wallMs),
      stat((r) => r.rounds),
      stat((r) => r.apiCalls.length),
      stat((r) => r.tokens.input),
      stat((r) => r.tokens.output),
      stat((r) => r.toolErrors.length),
    ];
  });
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
const runs = typeof args.runs === "string" ? Number(args.runs) : 1;
if (!Number.isInteger(runs) || runs < 1) {
  console.error(`--runs must be a positive integer, got ${args.runs}`);
  process.exit(2);
}
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
  for (let run = 1; run <= runs; run++) {
    const label = runs === 1 ? task.name : `${task.name} (${run}/${runs})`;
    process.stdout.write(`running ${label} ... `);
    const result = await runTask(task, { apiKey, model, blankBytes });
    results.push(result);
    console.log(
      `${result.pass ? "PASS" : "FAIL"} (${result.wallMs} ms, ${result.rounds} rounds)`,
    );
  }
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
