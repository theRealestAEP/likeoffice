import Anthropic from "@anthropic-ai/sdk";
import { ipcMain } from "electron";
import { readSettings } from "./settings";

export interface ModelRequest {
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

ipcMain.handle("model:message", async (_e, request: ModelRequest): Promise<ModelReply> => {
  if (process.env.LIKEOFFICE_FAKE_MODEL) {
    const shapeError = validateRequestShape(request);
    if (shapeError) return { error: `400 (fake): ${shapeError}` };
    return fakeReply(request.messages);
  }

  const { apiKey, model } = await readSettings();
  if (!apiKey) return { error: "No API key configured. Open Settings to add one." };

  try {
    const response = await new Anthropic({ apiKey }).messages.create({
      model,
      max_tokens: 16000,
      system: request.system,
      messages: request.messages,
      tools: request.tools,
    });
    return { content: response.content, stopReason: response.stop_reason };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
});
