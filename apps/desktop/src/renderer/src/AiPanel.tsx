import { useEffect, useRef, useState } from "react";
import type { AgentDocument } from "@wordinweb/agent";
import type { DocxViewApi } from "wordinweb";

const MAX_ROUNDS = 30;

const SYSTEM_PROMPT = `You edit the Word document the user has open in LikeOffice.

Inspect before you edit: read the relevant part of the document so your edits
address what is actually there. For bulk text work use word_document_project to
read a window of the document and word_document_patch to rewrite lines in it;
use word_document_edit for targeted structural or formatting changes.

Every edit you make is recorded as a tracked change for the user to accept or
reject, so make the change rather than describing what they should type.

Keep replies short — a sentence or two on what you changed.`;

const EDITING_TOOLS = new Set([
  "word_document_edit",
  "word_document_patch",
  "word_document_compose",
]);

interface Entry {
  role: "user" | "assistant" | "tool" | "error";
  text: string;
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
      const operation = op as { kind?: string };
      return operation.kind === "insertText" || operation.kind === "splitParagraph"
        ? { ...operation, suggest: true }
        : operation;
    }),
  };
}

export function AiPanel({
  agentDoc,
  api,
  hasKey,
  onOpenSettings,
  onEdited,
}: {
  agentDoc: AgentDocument;
  api: DocxViewApi;
  hasKey: boolean;
  onOpenSettings: () => void;
  onEdited: () => void;
}) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [suggested, setSuggested] = useState<number | null>(null);
  const history = useRef<ModelMessage[]>([]);

  // Keep the transcript pinned to the newest entry, but only while the user
  // has not scrolled up to read something older.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [entries, busy, suggested]);

  const add = (entry: Entry) => setEntries((list) => [...list, entry]);

  const run = async (text: string) => {
    setBusy(true);
    setSuggested(null);
    add({ role: "user", text });
    history.current.push({ role: "user", content: text });

    const tools = agentDoc.tools();
    // The Messages API requires input_schema.type === "object"; the engine's
    // inspect/edit tools are root-level anyOf unions without one.
    const definitions = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema:
        (t.inputSchema as { type?: string }).type === "object"
          ? t.inputSchema
          : { type: "object", ...(t.inputSchema as object) },
    }));

    const wasSuggesting = api.isSuggesting();
    api.setSuggesting(true, "AI");
    let edited = false;

    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const reply = await window.likeoffice.sendModelMessage({
          system: SYSTEM_PROMPT,
          messages: history.current,
          tools: definitions,
        });
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
          add({ role: "tool", text: call.name });
          const tool = tools.find((t) => t.name === call.name);
          if (!tool) {
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
            if (EDITING_TOOLS.has(call.name)) edited = true;
            results.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: JSON.stringify(output),
            });
          } catch (error) {
            results.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: error instanceof Error ? error.message : String(error),
              is_error: true,
            });
          }
        }
        history.current.push({ role: "user", content: results });
      }
      add({ role: "error", text: `Stopped after ${MAX_ROUNDS} tool rounds.` });
    } catch (error) {
      add({ role: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      api.setSuggesting(wasSuggesting);
      if (edited) {
        onEdited();
        setSuggested(api.revisionCount());
      }
      setBusy(false);
    }
  };

  const submit = () => {
    const text = input.trim();
    if (text === "" || busy) return;
    setInput("");
    void run(text);
  };

  const resolveAll = (accept: boolean) => {
    if (accept) api.acceptAllRevisions();
    else api.rejectAllRevisions();
    // The action row clears once nothing is left to review; the marks
    // disappearing from the document are the feedback.
    const remaining = api.revisionCount();
    setSuggested(remaining > 0 ? remaining : null);
    onEdited();
  };

  return (
    <div className="ai-panel">
      <div
        className="ai-transcript"
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        data-testid="ai-transcript"
      >
        {!hasKey && (
          <div className="ai-notice">
            Set your Anthropic API key in{" "}
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
        {busy && (
          <div className="ai-busy" role="status" aria-label="Working">
            <span />
            <span />
            <span />
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
        <div className={`ai-composer-box${hasKey ? "" : " disabled"}`}>
          <textarea
            className="ai-composer-input"
            value={input}
            disabled={!hasKey}
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
            disabled={!hasKey || busy || input.trim() === ""}
            aria-label="Send"
            title="Send"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 12.5v-9M4 7l4-3.5L12 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
