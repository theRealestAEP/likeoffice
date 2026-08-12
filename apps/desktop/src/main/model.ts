import Anthropic from "@anthropic-ai/sdk";
import { ipcMain } from "electron";
import { readSettings } from "./settings";

export interface ModelRequest {
  /** Correlates streamed deltas with the invoke that produced them. */
  requestId?: string;
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
}

export type ModelReply =
  | { content: Anthropic.ContentBlock[]; stopReason: string | null }
  | { error: string };

/** Scripted stand-in for the API, used by the e2e suite. It inspects the
 * document, inserts a sentence, then ends the turn. */
function fakeReply(messages: Anthropic.MessageParam[]): ModelReply {
  const round = messages.filter((m) => m.role === "assistant").length;
  if (round === 0) {
    return {
      content: [
        {
          type: "tool_use",
          id: "fake-1",
          name: "word_document_inspect",
          input: { kind: "search", query: "Hello" },
        } as Anthropic.ContentBlock,
      ],
      stopReason: "tool_use",
    };
  }
  if (round === 1) {
    const blocks = messages[messages.length - 1]?.content;
    const results = (Array.isArray(blocks) ? blocks : [])
      .map((block) => (block as { content?: unknown }).content)
      .filter((content): content is string => typeof content === "string")
      .join(" ");
    const revision = /"revision":"([^"]+)"/.exec(results)?.[1];
    const blockRef = /"blockRef":"(block:\d+)"/.exec(results)?.[1];
    const runRef = /"runRef":"(run:\d+)"/.exec(results)?.[1];
    if (!revision || !blockRef || !runRef) {
      return { error: `Fake model could not read the inspection: ${results.slice(0, 200)}` };
    }
    return {
      content: [
        {
          type: "tool_use",
          id: "fake-2",
          name: "word_document_edit",
          input: {
            revision,
            operations: [
              { kind: "insertText", at: { blockRef, runRef, offset: 0 }, text: "AI wrote this. " },
            ],
          },
        } as Anthropic.ContentBlock,
      ],
      stopReason: "tool_use",
    };
  }
  return {
    content: [{ type: "text", text: "Inserted the sentence.", citations: null }],
    stopReason: "end_turn",
  };
}

/** The real API's request-shape rules, enforced on the fake path too so the
 * e2e catches a malformed request before a live key ever sees it. This exists
 * because a root-anyOf tool schema passed the fake and 400'd in production —
 * twice: first for the missing type, then for the top-level combinator. */
function validateRequestShape(request: ModelRequest): string | null {
  for (let i = 0; i < request.tools.length; i++) {
    const schema = request.tools[i].input_schema as Record<string, unknown>;
    if (schema?.type !== "object") {
      return `tools.${i}.custom.input_schema.type: Field required`;
    }
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      if (key in schema) {
        return `tools.${i}.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level`;
      }
    }
  }
  return null;
}

ipcMain.handle("model:message", async (event, request: ModelRequest): Promise<ModelReply> => {
  if (process.env.LIKEOFFICE_FAKE_MODEL) {
    // e2e seam: the last system prompt the panel composed, readable from a
    // Playwright app.evaluate. Only the fake path records it.
    (globalThis as { __likeofficeLastSystem?: string }).__likeofficeLastSystem = request.system;
    const shapeError = validateRequestShape(request);
    if (shapeError) return { error: `400 (fake): ${shapeError}` };
    return fakeReply(request.messages);
  }

  const { apiKey, model } = await readSettings();
  if (!apiKey) return { error: "No API key configured. Open Settings to add one." };

  // Cache breakpoints on the system prompt and the last tool definition: both
  // are byte-stable across rounds, so round 2 of a tool loop reads the whole
  // prefix back at cache prices instead of re-processing the tool schemas.
  const tools = request.tools.map((tool, index) =>
    index === request.tools.length - 1
      ? { ...tool, cache_control: { type: "ephemeral" as const } }
      : tool,
  );

  try {
    const stream = new Anthropic({ apiKey }).messages.stream({
      model,
      max_tokens: 16000,
      system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
      messages: request.messages,
      tools,
    });
    stream.on("text", (text) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("model:delta", { requestId: request.requestId, text });
      }
    });
    const response = await stream.finalMessage();
    return { content: response.content, stopReason: response.stop_reason };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
});
