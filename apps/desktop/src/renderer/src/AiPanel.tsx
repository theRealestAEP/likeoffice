import { useEffect, useRef, useState } from "react";
import { AGENT_EDIT_CAPABILITIES, type AgentDocument } from "@wordinweb/agent";
import type { DocxViewApi } from "wordinweb";
import { AiProfileHeader, composeSystemPrompt, useProfiles } from "./AiProfiles";
import { Dropdown } from "./Dropdown";

const MAX_ROUNDS = 30;

/** The author stamped on every tracked change the panel makes, and the filter
 * its accept/reject buttons resolve by. One constant so the two can never
 * disagree — a mismatch would make the buttons no-ops. */
const AI_AUTHOR = "AI";

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

Your text and formatting edits are recorded as tracked changes for the user to
accept or reject. Structural inserts — tables, images, charts, shapes — have no
tracked form and apply directly, so say so when you make one. Either way, make
the change rather than describing what they should type.

Keep replies to a sentence.`;

const EDITING_TOOLS = new Set([
  "word_document_edit",
  "word_document_patch",
  "word_document_compose",
]);

/**
 * ASK MODE: answer, do not change.
 *
 * The tools are not merely discouraged in the prompt — they are NOT SENT. A
 * prompt that says "please don't edit" is a request; withholding the tool is
 * the only version a user can rely on, and it also means a prompt-injected
 * instruction inside the document or a fetched page has nothing to call.
 *
 * Reading and the web stay available, which is the whole point: "what does
 * this contract actually commit me to?" is a question, not an edit.
 */
const WRITING_TOOLS = new Set([
  "word_document_edit",
  "word_document_patch",
  "word_document_compose",
  "word_document_save",
]);

const ASK_PROMPT = `You are in ASK MODE. Answer questions about the document the
user has open. You have NO editing tools in this mode and must not claim to have
changed anything. If the user asks for a change, say what you would change and
where — quoting the lines — and tell them to switch the panel to Edit to have it
made.`;

interface Entry {
  role: "user" | "assistant" | "tool" | "error";
  text: string;
}

/** What the panel says while it waits for the model. */
const THINKING = "Thinking…";

/** The edit operations worth naming on their own line. Everything else the
 * edit tool carries reads as an edit, which is what it is. */
const EDIT_ACTIVITY: Record<string, string> = {
  insertText: "Editing the text…",
  deleteText: "Editing the text…",
  formatRun: "Formatting…",
  formatParagraph: "Formatting…",
  formatRange: "Formatting…",
  insertTable: "Inserting a table…",
  tableOp: "Editing a table…",
  insertImage: "Inserting an image…",
  insertChart: "Inserting a chart…",
  insertSmartArt: "Inserting a diagram…",
  insertShape: "Inserting a shape…",
  insertMath: "Inserting an equation…",
  insertFootnote: "Adding a footnote…",
  commentRun: "Adding a comment…",
};

/** The line the panel shows while a tool runs. It reports only what the panel
 * has seen: the tool the model asked for, and — for a document edit — the
 * kind of its first operation. Anything else reads as plain work. */
export function activityLabel(name: string, input: unknown): string {
  switch (name) {
    case "word_document_project":
    case "word_document_inspect":
      return "Reading the document…";
    case "word_document_asset":
      return "Looking at an image…";
    case "word_document_capabilities":
      return "Checking what it can edit…";
    case "word_document_patch":
      return "Editing the text…";
    case "word_document_compose":
      return "Writing new content…";
    case "word_document_save":
      return "Saving…";
    case "web_search":
      return "Searching the web…";
    case "web_fetch":
      return "Reading a page…";
    case "word_document_edit": {
      const operations = (input as { operations?: unknown } | null)?.operations;
      const first = Array.isArray(operations) ? (operations[0] as { kind?: string }) : undefined;
      return EDIT_ACTIVITY[first?.kind ?? ""] ?? "Editing the document…";
    }
    default:
      return "Working…";
  }
}

/** The window a projection covers, plus what patches need to address it. */
interface ProjectionWindow {
  revision: string;
  text: string;
  truncated: boolean;
  next?: { value: string };
}

const PROJECTION_MAX_CHARACTERS = 50_000;
const STORY_MAX_CHARACTERS = 2_000;

/** The non-body story kinds word_document_project addresses. Overview also
 * lists textbox stories, which the projector does not take — their content is
 * reachable through object inspection instead. */
const PROJECTED_STORY_KINDS = ["header", "footer", "footnote", "endnote"];

type AgentTool = ReturnType<AgentDocument["tools"]>[number];

function numberLines(text: string): string {
  return text
    .split("\n")
    .map((line, index) => `${index + 1}: ${line}`)
    .join("\n");
}

/** Every non-body story that holds content, each as its own tag. The overview
 * names the document's stories, so nothing has to be probed for. These project
 * in md mode: a footer's page number then reads as {{PAGE}} rather than the
 * opaque field atom text mode writes, which is the whole point of showing it. */
async function storyBlocks(tools: AgentTool[], project: AgentTool): Promise<string> {
  const inspect = tools.find((t) => t.name === "word_document_inspect");
  if (!inspect) return "";
  try {
    const overview = (await inspect.execute({ kind: "overview" })) as {
      stories: { id: string; kind: string }[];
    };
    let blocks = "";
    for (const story of overview.stories) {
      if (!PROJECTED_STORY_KINDS.includes(story.kind)) continue;
      const projection = (await project.execute({
        story: story.id,
        mode: "md",
        maxCharacters: STORY_MAX_CHARACTERS,
      })) as ProjectionWindow;
      if (projection.text.trim() === "") continue;
      blocks += `\n<story kind="${story.kind}" ref="${story.id}" mode="md">\n${numberLines(projection.text)}\n</story>`;
    }
    return blocks;
  } catch {
    // The body projection is worth sending on its own.
    return "";
  }
}

/** Read the document body once, up front, and fold it into the user's message
 * as numbered lines. A text-only ask can then patch in the first round with
 * no inspection round-trip. The projection stays cached on the AgentDocument,
 * so the patch's line numbers resolve against exactly this window. */
async function projectionMessage(
  tools: ReturnType<AgentDocument["tools"]>,
  ask: string,
): Promise<string> {
  const project = tools.find((t) => t.name === "word_document_project");
  if (!project) return ask;
  try {
    const projection = (await project.execute({
      story: "body",
      mode: "text",
      maxCharacters: PROJECTION_MAX_CHARACTERS,
    })) as ProjectionWindow;
    const numbered = numberLines(projection.text);
    const stories = await storyBlocks(tools, project);
    const note =
      projection.truncated && projection.next
        ? `\n(The projection is truncated. Project further windows with word_document_project and cursor "${projection.next.value}".)`
        : "";
    return `<document story="body" mode="text" revision="${projection.revision}">\n${numbered}${stories}\n</document>${note}\n\n${ask}`;
  } catch {
    // Without a projection the model falls back to inspecting via tools.
    return ask;
  }
}

/** The operations the engine records as tracked changes, read from its own
 * capability map: a kind that has a tracked OOXML form lists `suggest` among
 * its optional fields. Deriving the set means an operation the engine learns
 * to track arrives here tracked, with no list to keep in step. */
const SUGGESTABLE_KINDS = new Set(
  Object.entries(AGENT_EDIT_CAPABILITIES)
    .filter(([, capability]) => capability.optional?.includes("suggest"))
    .map(([kind]) => kind),
);


/** Whether this operation lands as a tracked change when it carries the flag.
 * tableOp is the one split kind: its three PROPERTY operations arrive as
 * objects and record a *PrChange, while the structural ones — row and column
 * inserts and deletes, merges, splits — are plain strings the engine applies
 * outright, as insertTable and the object inserts do. */
function suggestable(operation: { kind?: string; op?: unknown }): boolean {
  if (!SUGGESTABLE_KINDS.has(operation.kind ?? "")) return false;
  if (operation.kind === "tableOp") return typeof operation.op === "object" && operation.op !== null;
  return true;
}

/** Ask the engine to record this call's edits as tracked changes. The agent
 * tools take `suggest` per operation, so the flag goes in on the way past. */
function withSuggestions(name: string, input: unknown): unknown {
  const value = (input ?? {}) as Record<string, unknown>;
  if (name === "word_document_patch") return { ...value, suggest: true };
  if (name !== "word_document_edit") return input;
  const operations = Array.isArray(value.operations) ? value.operations : [];
  return {
    ...value,
    operations: operations.map((op) => {
      const operation = op as { kind?: string; op?: unknown };
      return suggestable(operation) ? { ...operation, suggest: true } : operation;
    }),
  };
}

export function AiPanel({
  agentDoc,
  api,
  settings,
  onOpenSettings,
  onSettingsChanged,
  onEdited,
}: {
  agentDoc: AgentDocument;
  api: DocxViewApi;
  settings: SettingsView;
  onOpenSettings: () => void;
  /** The model picker writes settings from inside the panel; the app owns the
   * state, so the new view goes back up rather than being held twice. */
  onSettingsChanged: (next: SettingsView) => void;
  onEdited: () => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  /** "edit" makes changes; "ask" answers without them. */
  const [mode, setMode] = useState<"edit" | "ask">("edit");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // What the panel is doing right now: waiting on the model, or running the
  // tool it names. The live text takes over once the model streams tokens.
  const [activity, setActivity] = useState(THINKING);
  const [suggested, setSuggested] = useState<number | null>(null);
  // Model text as it streams in, shown live and replaced by the final reply.
  // Null whenever no delta has arrived for the in-flight request.
  const [streamText, setStreamText] = useState<string | null>(null);
  const history = useRef<ModelMessage[]>([]);
  // Plain-text exchange log for the subscription providers, whose agent runs
  // are one per user message and otherwise stateless.
  const agentLog = useRef<{ role: "user" | "assistant"; text: string }[]>([]);

  // The active AI profile, appended to SYSTEM_PROMPT below for every provider.
  const profiles = useProfiles();

  // The two CLI-driven providers run an agent session in the main process; the
  // rest are called directly and need a key of their own. Ollama is the
  // exception — a server on this machine has nobody to authenticate.
  const subscription =
    settings.provider === "claude-subscription" || settings.provider === "codex-subscription";
  const ready = subscription || settings.provider === "ollama" || settings.hasKey;

  // Closing the panel cancels any in-flight subscription agent run.
  useEffect(() => {
    return () => window.likeoffice.cancelAgent();
  }, []);

  // Keep the transcript pinned to the newest entry, but only while the user
  // has not scrolled up to read something older.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [entries, busy, suggested, streamText, activity]);

  const add = (entry: Entry) => setEntries((list) => [...list, entry]);

  /** Show a state, and wait for the panel to paint it. The engine's tools run
   * as one long synchronous block on this thread, so without the frame the
   * label would only reach the screen after the work it names had finished. */
  const showActivity = async (label: string) => {
    setActivity(label);
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  };

  const run = async (text: string) => {
    setBusy(true);
    setActivity(THINKING);
    setSuggested(null);
    add({ role: "user", text });

    const tools = agentDoc.tools();
    const wasSuggesting = api.isSuggesting();
    // Tracked-change capture is for edits; Ask mode makes none.
    if (mode === "edit") api.setSuggesting(true, AI_AUTHOR);
    const edited = { current: false };

    try {
      if (subscription) await runAgentTurn(tools, text, edited);
      else await runApiLoop(tools, text, edited);
    } catch (error) {
      add({ role: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setStreamText(null);
      if (mode === "edit") api.setSuggesting(wasSuggesting);
      if (edited.current) {
        onEdited();
        setSuggested(api.revisionCount(AI_AUTHOR));
      }
      setBusy(false);
    }
  };

/**
 * The two web tools, offered alongside the document tools.
 *
 * A document assistant that cannot look anything up has to be told every fact
 * it writes. Search finds the sources; fetch reads one. Both execute in the
 * main process (see main/web-tools.ts) — the renderer holds a document, not a
 * licence to fetch the internet.
 */
const WEB_TOOLS: ModelToolDefinition[] = [
  {
    name: "web_search",
    description:
      "Search the web and return titles, URLs and snippets. Use it to find sources before writing a claim you cannot verify from the document. Follow up with web_fetch to read a result before quoting it.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "What to search for." } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch one http(s) URL and return its readable text. Use it to read a search result, or a link the user gave you, before quoting or citing it.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "The http or https URL to read." } },
      required: ["url"],
      additionalProperties: false,
    },
  },
];

/** True when the model asked for a web tool rather than a document one. */
function isWebTool(name: string): boolean {
  return name === "web_search" || name === "web_fetch";
}

async function executeWebTool(name: string, input: unknown): Promise<{ content: string; isError: boolean }> {
  const args = (input ?? {}) as { query?: unknown; url?: unknown };
  const outcome =
    name === "web_search"
      ? await window.likeoffice.webSearch(String(args.query ?? ""))
      : await window.likeoffice.webFetch(String(args.url ?? ""));
  // A failed lookup is a RESULT, not an exception: the model should read why it
  // failed and either try a different query or write without the source.
  if ("error" in outcome) return { content: outcome.error, isError: true };
  return { content: JSON.stringify(outcome), isError: false };
}

  /** Execute one document tool call on behalf of whichever provider asked. */
  const executeTool = async (
    tools: ReturnType<AgentDocument["tools"]>,
    name: string,
    input: unknown,
    edited: { current: boolean },
  ): Promise<{ content: string; isError: boolean }> => {
    add({ role: "tool", text: name });
    // ENFORCED AT EXECUTION, not just by omitting the definition. Withholding a
    // tool from the request stops a cooperative model; it does not stop one that
    // names the tool anyway, and it does not stop a prompt injection inside the
    // document or a fetched page from talking it into trying. The gate has to be
    // where the call would actually run.
    if (mode === "ask" && WRITING_TOOLS.has(name)) {
      return {
        content: `${name} is not available in Ask mode. Tell the user what you would change and where; they can switch the panel to Edit to have it made.`,
        isError: true,
      };
    }
    if (isWebTool(name)) {
      await showActivity(activityLabel(name, input));
      try {
        return await executeWebTool(name, input);
      } finally {
        setActivity(THINKING);
      }
    }
    const tool = tools.find((t) => t.name === name);
    if (!tool) return { content: `Unknown tool ${name}`, isError: true };
    await showActivity(activityLabel(name, input));
    try {
      const output = await tool.execute(withSuggestions(name, input));
      if (EDITING_TOOLS.has(name)) edited.current = true;
      return { content: JSON.stringify(output), isError: false };
    } catch (error) {
      return {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    } finally {
      // The result goes straight back to the model, so the wait resumes.
      setActivity(THINKING);
    }
  };

  /** Subscription providers: one agent run per user message, driven in the
   * main process. Tool calls come back over IPC and execute here, against
   * the live document, with the suggest flag injected as usual. */
  const runAgentTurn = async (
    tools: ReturnType<AgentDocument["tools"]>,
    text: string,
    edited: { current: boolean },
  ) => {
    const definitions = [
      ...tools
        // Ask mode WITHHOLDS the writing tools rather than asking the model not
        // to use them. See WRITING_TOOLS.
        .filter((t) => mode === "edit" || !WRITING_TOOLS.has(t.name))
        .map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
      // Offered only when the user has web access configured, so a model is
      // never handed a tool that can only fail.
      ...(settings.web.enabled ? WEB_TOOLS : []),
    ];
    const context = agentLog.current
      .map((e) => `${e.role === "user" ? "User" : "Assistant"}: ${e.text}`)
      .join("\n");
    const ask = context === "" ? text : `Earlier conversation:\n${context}\n\nUser: ${text}`;
    // The panel reads the document itself before it asks anything, and on a
    // long document that read is the first thing the user waits on.
    await showActivity(activityLabel("word_document_project", null));
    const prompt = await projectionMessage(tools, ask);
    setActivity(THINKING);
    agentLog.current.push({ role: "user", text });

    const sessionId = crypto.randomUUID();
    const offEvent = window.likeoffice.onAgentEvent((event) => {
      if (event.sessionId !== sessionId) return;
      if (event.type === "delta" && event.text) {
        setStreamText((current) => (current ?? "") + event.text);
      } else if (event.type === "assistant" && event.text) {
        setStreamText(null);
        add({ role: "assistant", text: event.text });
        agentLog.current.push({ role: "assistant", text: event.text });
      }
    });
    const offCall = window.likeoffice.onAgentToolCall((call) => {
      if (call.sessionId !== sessionId) return;
      void executeTool(tools, call.name, call.input, edited).then((result) =>
        window.likeoffice.sendAgentToolResult({ callId: call.callId, ...result }),
      );
    });

    try {
      const reply = await window.likeoffice.runAgent({
        sessionId,
        system: composeSystemPrompt(mode === "ask" ? ASK_PROMPT : SYSTEM_PROMPT, profiles.active),
        prompt,
        tools: definitions,
      });
      if (reply.error) add({ role: "error", text: reply.error });
    } finally {
      offEvent();
      offCall();
    }
  };

  /** Anthropic API key (and the fake model): the tool loop runs here in the
   * renderer, one messages.create round per tool round. */
  const runApiLoop = async (
    tools: ReturnType<AgentDocument["tools"]>,
    text: string,
    edited: { current: boolean },
  ) => {
    const definitions = [
      ...tools
        // Ask mode WITHHOLDS the writing tools rather than asking the model not
        // to use them. See WRITING_TOOLS.
        .filter((t) => mode === "edit" || !WRITING_TOOLS.has(t.name))
        .map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
      // Offered only when the user has web access configured, so a model is
      // never handed a tool that can only fail.
      ...(settings.web.enabled ? WEB_TOOLS : []),
    ];

    // As in the agent path: the up-front read is a wait the user can see.
    await showActivity(activityLabel("word_document_project", null));
    history.current.push({ role: "user", content: await projectionMessage(tools, text) });
    setActivity(THINKING);

    const activeRequest = { current: "" };
    const unsubscribe = window.likeoffice.onModelDelta(({ requestId, text: delta }) => {
      if (requestId === activeRequest.current) {
        setStreamText((current) => (current ?? "") + delta);
      }
    });

    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        activeRequest.current = crypto.randomUUID();
        setStreamText(null);
        const reply = await window.likeoffice.sendModelMessage({
          requestId: activeRequest.current,
          system: composeSystemPrompt(mode === "ask" ? ASK_PROMPT : SYSTEM_PROMPT, profiles.active),
          messages: history.current,
          tools: definitions,
        });
        activeRequest.current = "";
        setStreamText(null);
        if (reply.error !== undefined) {
          add({ role: "error", text: reply.error });
          return;
        }

        history.current.push({ role: "assistant", content: reply.content });
        for (const block of reply.content) {
          if (block.type === "text") add({ role: "assistant", text: (block as ModelText).text });
        }

        const calls = reply.content.filter((b): b is ModelToolUse => b.type === "tool_use");
        if (calls.length === 0) return;

        const results: ModelToolResult[] = [];
        for (const call of calls) {
          const result = await executeTool(tools, call.name, call.input, edited);
          results.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: result.content,
            ...(result.isError ? { is_error: true } : {}),
          });
        }
        history.current.push({ role: "user", content: results });
      }
      add({ role: "error", text: `Stopped after ${MAX_ROUNDS} tool rounds.` });
    } finally {
      unsubscribe();
    }
  };

  const submit = () => {
    const text = input.trim();
    if (text === "" || busy) return;
    setInput("");
    void run(text);
  };

  /**
   * Resolve only the ASSISTANT'S tracked changes.
   *
   * These buttons used to accept or reject every revision in the document. Open
   * a file carrying a co-author's tracked changes, ask for one edit, click
   * "Reject all", and their work was silently discarded — and the count beside
   * the buttons had been describing their revisions too. The panel owns what it
   * authored and nothing else.
   */
  const resolveAll = (accept: boolean) => {
    if (accept) api.acceptAllRevisions(AI_AUTHOR);
    else api.rejectAllRevisions(AI_AUTHOR);
    // The action row clears once nothing is left to review; the marks
    // disappearing from the document are the feedback.
    const remaining = api.revisionCount(AI_AUTHOR);
    setSuggested(remaining > 0 ? remaining : null);
    onEdited();
  };

  return (
    <div className="ai-panel">
      <AiProfileHeader profiles={profiles} />
      <div
        className="ai-transcript"
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        data-testid="ai-transcript"
      >
        {!ready && (
          <div className="ai-notice">
            {/* Name the provider that is actually selected: "set your Anthropic
                key" is wrong advice the moment someone picks OpenRouter. */}
            Add a key for {settings.providers.find((p) => p.id === settings.provider)?.label ?? "this provider"} in{" "}
            <button className="btn-link" onClick={onOpenSettings}>
              Settings
            </button>{" "}
            to use the assistant.
          </div>
        )}
        {entries.map((entry, i) =>
          entry.role === "tool" ? (
            <div key={i} className="ai-entry ai-entry-tool" title={entry.text}>
              {entry.text}
            </div>
          ) : (
            <p key={i} className={`ai-entry ai-entry-${entry.role}`}>
              {entry.text}
            </p>
          ),
        )}
        {streamText !== null && (
          <p className="ai-entry ai-entry-assistant ai-entry-streaming" role="status">
            {streamText}
          </p>
        )}
        {busy && streamText === null && (
          <div className="ai-busy" role="status" data-testid="ai-activity">
            <span className="ai-busy-dot" aria-hidden="true" />
            {activity}
          </div>
        )}
        {suggested !== null && (
          <div className="ai-actions" data-testid="ai-suggested">
            <span className="ai-actions-count">
              {suggested} suggested change{suggested === 1 ? "" : "s"}
            </span>
            {suggested > 0 && (
              <>
                <button className="btn-link muted" onClick={() => resolveAll(false)}>
                  Reject all
                </button>
                <button className="btn-link" onClick={() => resolveAll(true)}>
                  Accept all
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <div className="ai-composer">
        <div className={`ai-composer-box${ready ? "" : " disabled"}`}>
          <textarea
            className="ai-composer-input"
            value={input}
            disabled={!ready}
            placeholder="Ask for an edit…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={3}
            data-testid="ai-input"
          />
          <button
            className="ai-send"
            onClick={submit}
            disabled={!ready || busy || input.trim() === ""}
            aria-label="Send"
            title="Send"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 12.5v-9M4 7l4-3.5L12 7" />
            </svg>
          </button>
        </div>
        <div className="ai-mode-row">
          <div className="ai-mode" role="radiogroup" aria-label="Assistant mode">
            {(["edit", "ask"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                className={`ai-mode-btn${mode === m ? " ai-mode-btn-active" : ""}`}
                onClick={() => setMode(m)}
                title={m === "edit" ? "Make changes to the document" : "Answer without changing anything"}
                data-testid={`ai-mode-${m}`}
              >
                {m === "edit" ? "Edit" : "Ask"}
              </button>
            ))}
          </div>
          <ModelPicker settings={settings} onChanged={onSettingsChanged} />
        </div>
      </div>
    </div>
  );
}

/**
 * Provider and model, switchable without leaving the document.
 *
 * Changing model is a per-message decision — a cheap model to redraft a
 * paragraph, an expensive one to restructure a chapter — and routing that
 * through a modal settings dialog made it a decision people stopped making.
 * The write goes through the same patch API the settings page uses, so the two
 * cannot drift.
 */
function ModelPicker({
  settings,
  onChanged,
}: {
  settings: SettingsView;
  onChanged: (next: SettingsView) => void;
}) {
  const [catalogue, setCatalogue] = useState<ModelCatalogue | null>(null);
  const active = settings.providers.find((p) => p.id === settings.provider);

  useEffect(() => {
    let live = true;
    setCatalogue(null);
    void window.likeoffice.listModels(settings.provider).then((c) => {
      if (live) setCatalogue(c);
    });
    return () => {
      live = false;
    };
  }, [settings.provider]);

  // Codex picks its own model; offering a list here would be a lie.
  const showModel = settings.provider !== "codex-subscription";
  // The saved model may not be in the fetched list (a typed id, or a list that
  // has not caught up). Keep it as an option so the control never silently
  // reports a model other than the one that will answer.
  const options = catalogue?.models ?? [];
  const known = options.some((m) => m.id === active?.model);

  const patch = async (next: SettingsPatch) => {
    onChanged(await window.likeoffice.setSettings(next));
  };

  // The saved model may not be in the fetched list (a typed id, or a list that
  // has not caught up). Keep it as an option so the control never reports a
  // model other than the one that will answer.
  const modelOptions = [
    ...(!known && active?.model ? [{ value: active.model, label: active.model }] : []),
    ...options.map((m) => ({ value: m.id, label: m.id, hint: m.label !== m.id ? m.label : undefined })),
  ];

  return (
    <div className="ai-model-bar">
      <Dropdown
        className="dd-bare ai-model-provider"
        ariaLabel="AI provider"
        testId="ai-provider"
        value={settings.provider}
        options={settings.providers.map((p) => ({ value: p.id, label: p.label }))}
        onChange={(next) => void patch({ provider: next as Provider })}
      />
      {showModel && (
        <Dropdown
          className="dd-bare ai-model-model"
          ariaLabel="Model"
          testId="ai-model"
          value={active?.model ?? ""}
          placeholder="No model chosen"
          freeText
          searchable
          options={modelOptions}
          onChange={(next) => void patch({ providers: { [settings.provider]: { model: next } } })}
        />
      )}
    </div>
  );
}
