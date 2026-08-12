#!/usr/bin/env node
// Agent editing-speed benchmark for LikeOffice.
//
// Headless (no Electron): drives the same agentic loop the app's AI panel
// uses — LocalDocumentSession + AgentDocument tools against the real
// Anthropic Messages API — then asserts on the final saved bytes.
//
// Usage:
//   nice -n 19 node bench/agent-bench.mjs [--model=claude-opus-5] [--task=name,name]
//                                         [--runs=N] [--tools=defs|full|menu] [--cache]
//                                         [--batch=name] [--position=1|2]
//
// --tools picks the tool payload: "defs" (the default) is what the engine
// emits, with the operations union's repeated content subschemas hoisted into
// $defs; "full" expands every $ref again, reproducing the pre-hoist payload
// byte for byte; "menu" is the tiered-union experiment described beside
// toolPayload. --cache mirrors model.ts's prompt-cache breakpoints.
// --batch and --position record which experiment a run belongs to and where it
// sat inside its pair; ab-tools.sh sets both.
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
import { AGENT_EDIT_CAPABILITIES, AgentDocument, LocalDocumentSession, agentCapabilities, hoistRepeatedSubschemas } from "@wordinweb/agent";
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

/** Mirrors AiPanel.tsx: the kinds the engine records as tracked changes are
 * the ones its capability map gives an optional `suggest` field. */
const SUGGESTABLE_KINDS = new Set(
  Object.entries(AGENT_EDIT_CAPABILITIES)
    .filter(([, capability]) => capability.optional?.includes("suggest"))
    .map(([kind]) => kind),
);

// Mirrors AiPanel.tsx: these two declare the flag and the engine's edit
// compiler refuses it, so sending it would break the operation rather than
// track it.
SUGGESTABLE_KINDS.delete("setParagraphBorders");
SUGGESTABLE_KINDS.delete("setTabStops");

/** Mirrors AiPanel.tsx: tableOp's three PROPERTY operations arrive as objects
 * and record a *PrChange; its structural ones are plain strings the engine
 * applies outright. */
function suggestable(operation) {
  if (!SUGGESTABLE_KINDS.has(operation?.kind)) return false;
  if (operation.kind === "tableOp") return typeof operation.op === "object" && operation.op !== null;
  return true;
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
    operations: operations.map((op) => (suggestable(op) ? { ...op, suggest: true } : op)),
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
          // model.ts marks the system prompt and the last tool as cache
          // breakpoints, so rounds 2+ of a turn read the whole prefix back at
          // cache prices. --cache turns that on here too. It is off by default
          // because the recorded history is uncached, and because the cached
          // and uncached costs of a schema change are different questions.
          system: request.cache
            ? [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }]
            : request.system,
          messages: request.messages,
          tools: request.cache
            ? request.tools.map((tool, index) =>
                index === request.tools.length - 1
                  ? { ...tool, cache_control: { type: "ephemeral" } }
                  : tool,
              )
            : request.tools,
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
      cacheWriteTokens: json.usage?.cache_creation_input_tokens ?? 0,
      cacheReadTokens: json.usage?.cache_read_input_tokens ?? 0,
    };
  }
}

// --- Tool payload arms ------------------------------------------------------

// The tool definitions are the dominant per-round input: on a blank document
// they alone count ~31.5k tokens, which is essentially the whole 32k round.
// The engine now ships the operations union with its repeated subschemas
// hoisted into $defs. --tools=full expands every $ref again, which reproduces
// the pre-hoist payload byte for byte, so an A/B compares two payloads that
// really do differ rather than two arms that cannot.
function expandRefs(node, defs) {
  if (Array.isArray(node)) return node.map((entry) => expandRefs(entry, defs));
  if (!node || typeof node !== "object") return node;
  if (typeof node.$ref === "string") {
    return expandRefs(defs[node.$ref.replace("#/$defs/", "")], defs);
  }
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, expandRefs(value, defs)]));
}

// --tools=menu goes further, and is an experiment rather than something the
// engine ships. Operations that put content into the document keep their full
// field schema inline. Operations that adjust something already there are
// named in one open branch, with their purpose and their field names, and the
// model fetches exact types from word_document_capabilities if it needs them.
// The split is create-vs-adjust, not a list of the operations this benchmark
// happens to use.
const MENU_CATEGORIES = ["text", "paragraph", "math", "insert"];

const MENU_PROMPT_SENTENCE = `
Most word_document_edit operations carry their full field schema. The rest are
listed by name, purpose, and field names in the last branch of the operations
union; call word_document_capabilities with one of those kinds when you need
its exact field types before writing the call.`;

function menuOperationsUnion(inline, rest) {
  return {
    anyOf: [
      ...inline.map((c) => c.inputSchema),
      {
        type: "object",
        description:
          "Any other operation. Its fields are listed here; call word_document_capabilities with its kind for the exact types and ranges.\n" +
          rest
            .map(
              (c) =>
                `${c.kind}(${[...c.required, ...(c.optional ?? []).map((o) => `${o}?`)].join(", ")}) — ${c.description}`,
            )
            .join("\n"),
        properties: { kind: { enum: rest.map((c) => c.kind) } },
        required: ["kind"],
      },
    ],
  };
}

function menuEditSchema() {
  const caps = agentCapabilities();
  return hoistRepeatedSubschemas({
    type: "object",
    properties: {
      revision: { type: "string", minLength: 1 },
      operations: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: menuOperationsUnion(
          caps.filter((c) => MENU_CATEGORIES.includes(c.category)),
          caps.filter((c) => !MENU_CATEGORIES.includes(c.category)),
        ),
      },
    },
    required: ["revision", "operations"],
    additionalProperties: false,
  });
}

function toolPayload(tools, arm) {
  return tools.map((t) => {
    const schema = t.inputSchema;
    if (arm === "menu" && t.name === "word_document_edit") {
      return { name: t.name, description: t.description, input_schema: menuEditSchema() };
    }
    if (arm !== "full" || !schema?.$defs) {
      return { name: t.name, description: t.description, input_schema: schema };
    }
    const { $defs, ...rest } = schema;
    return { name: t.name, description: t.description, input_schema: expandRefs(rest, $defs) };
  });
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

async function runTask(task, { apiKey, model, blankBytes, arm, cache, batch, position }) {
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
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
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
  const definitions = toolPayload(tools, arm);
  metrics.toolPayloadChars = JSON.stringify(definitions).length;
  metrics.arm = arm;
  metrics.cache = cache;
  // Which experiment this run belongs to, and where it sat inside its pair.
  // Several interleaved streams can run at once, so a timestamp no longer
  // identifies an experiment, and an A/A batch has nothing but the position.
  metrics.batch = batch;
  metrics.position = position;

  const firstMessage = await projectionMessage(tools, task.prompt);
  const messages = [{ role: "user", content: firstMessage }];
  metrics.transcript.push({ round: 0, role: "user", text: clip(firstMessage) });
  const started = Date.now();

  try {
    let round = 0;
    for (; round < MAX_ROUNDS; round++) {
      const reply = await callModel(apiKey, {
        model,
        system: arm === "menu" ? SYSTEM_PROMPT + "\n" + MENU_PROMPT_SENTENCE : SYSTEM_PROMPT,
        messages,
        tools: definitions,
        cache,
      });
      messages.push({ role: "assistant", content: reply.content });
      const calls = reply.content.filter((b) => b.type === "tool_use");
      metrics.apiCalls.push({
        ms: reply.ms,
        inputTokens: reply.inputTokens,
        outputTokens: reply.outputTokens,
        cacheWriteTokens: reply.cacheWriteTokens,
        cacheReadTokens: reply.cacheReadTokens,
        stopReason: reply.stopReason,
        // What the model asked for this round, in order: a slow run is only
        // diagnosable if the round-by-round sequence survives in the JSON.
        tools: calls.map((c) => c.name),
      });
      metrics.tokens.input += reply.inputTokens;
      metrics.tokens.output += reply.outputTokens;
      metrics.tokens.cacheWrite += reply.cacheWriteTokens;
      metrics.tokens.cacheRead += reply.cacheReadTokens;
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
  const headers = ["task", "pass", "ms", "rounds", "api calls", "in tok", "cache rd", "out tok", "tool errs"];
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
      stat((r) => r.tokens.cacheRead),
      stat((r) => r.tokens.output),
      stat((r) => r.toolErrors.length),
    ];
  });
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

// --- Main ------------------------------------------------------------------

// Running this file is what normally happens; importing it is what
// bench/menu-escape-probe.mjs does, to reuse the request shape and the tool
// payload arms instead of copying them.
export { SYSTEM_PROMPT, MENU_PROMPT_SENTENCE, callModel, readApiKey, toolPayload };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const m = a.match(/^--([^=]+)(?:=(.*))?$/);
      return m ? [m[1], m[2] ?? true] : [a, true];
    }),
  );
  const model = typeof args.model === "string" ? args.model : "claude-opus-5";
  const arm = typeof args.tools === "string" ? args.tools : "defs";
  if (arm !== "defs" && arm !== "full" && arm !== "menu") {
    console.error(`--tools must be defs, full, or menu, got ${args.tools}`);
    process.exit(2);
  }
  const cache = args.cache === true;
  const batch = typeof args.batch === "string" ? args.batch : undefined;
  const position = typeof args.position === "string" ? Number(args.position) : undefined;
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
      const result = await runTask(task, { apiKey, model, blankBytes, arm, cache, batch, position });
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
  // Two invocations that start in the same second must not overwrite each
  // other: A/B batches are run several at a time.
  let resultsPath = path.join(resultsDir, `${stamp}.json`);
  for (let n = 2; fs.existsSync(resultsPath); n++) resultsPath = path.join(resultsDir, `${stamp}-${n}.json`);
  fs.writeFileSync(
    resultsPath,
    JSON.stringify({ startedAt: startedAt.toISOString(), model, arm, cache, batch, position, results }, null, 2),
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
        arm: r.arm,
        cache: r.cache,
        batch: r.batch,
        toolPayloadChars: r.toolPayloadChars,
        pass: r.pass,
      }) + "\n",
    );
  }

  console.log(
    `\narm: --tools=${arm}${cache ? " --cache" : ""}, tool payload ${results[0]?.toolPayloadChars ?? 0} chars`,
  );
  console.log(summaryTable(results));
  for (const r of results) {
    if (r.failures.length > 0) {
      console.log(`\n${r.task} failures:`);
      for (const f of r.failures) console.log(`  - ${f}`);
    }
  }
  console.log(`\nresults: ${path.relative(REPO_ROOT, resultsPath)}`);

  process.exit(results.every((r) => r.pass) ? 0 : 1);
}
