import type Anthropic from "@anthropic-ai/sdk";

/**
 * OpenAI chat-completions transport, speaking Anthropic's shapes.
 *
 * The renderer's whole agent loop — the panel's history, its tool-call
 * handling, the engine's tool definitions — is written against Anthropic's
 * message format. Rather than fork that loop per vendor, every OpenAI-style
 * provider (OpenAI, OpenRouter, Ollama, and any custom base URL) is translated
 * HERE, at the edge, so the renderer never learns which vendor answered.
 *
 * The translation is deliberately narrow: text, tool definitions, tool calls
 * and tool results. That is the entire vocabulary the document agent uses.
 */

export interface CompatRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  /** Called with each streamed text fragment. */
  onText: (text: string) => void;
  signal?: AbortSignal;
}

export type CompatReply =
  | { content: Anthropic.ContentBlock[]; stopReason: string | null }
  | { error: string };

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

/** Anthropic content blocks -> OpenAI messages.
 *
 * The shapes disagree on where a tool RESULT lives: Anthropic carries results
 * as blocks inside a user message, OpenAI wants one message per result with
 * role "tool". One Anthropic message can therefore become several. */
function toOpenAiMessages(system: string, messages: Anthropic.MessageParam[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: "system", content: system }];
  for (const message of messages) {
    const blocks = typeof message.content === "string"
      ? [{ type: "text" as const, text: message.content }]
      : message.content;
    if (message.role === "assistant") {
      const text = blocks
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const calls = blocks
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: "function" as const,
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      out.push({
        role: "assistant",
        content: text === "" ? null : text,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
      continue;
    }
    // A user message: tool results become their own "tool" messages, and any
    // plain text stays a user message. Results go FIRST — OpenAI requires each
    // tool result to directly follow the assistant turn that asked for it.
    const results = blocks.filter(
      (b): b is Anthropic.ToolResultBlockParam => b.type === "tool_result",
    );
    for (const result of results) {
      const content = typeof result.content === "string"
        ? result.content
        : (result.content ?? [])
            .map((part) => ("text" in part ? part.text : ""))
            .join("");
      out.push({ role: "tool", tool_call_id: result.tool_use_id, content });
    }
    const text = blocks
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (text !== "") out.push({ role: "user", content: text });
  }
  return out;
}

function toOpenAiTools(tools: Anthropic.Tool[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.input_schema,
    },
  }));
}

/** OpenAI finish_reason -> Anthropic stop_reason, the two values the panel's
 * loop actually branches on. */
function toStopReason(finish: string | null | undefined): string | null {
  if (finish === "tool_calls") return "tool_use";
  if (finish === "stop") return "end_turn";
  if (finish === "length") return "max_tokens";
  return finish ?? null;
}

/**
 * Accumulates a streamed chat completion.
 *
 * Tool calls arrive in fragments keyed by index — the name in one delta, the
 * arguments across many — so they are assembled by index rather than appended.
 */
class StreamAccumulator {
  text = "";
  finish: string | null = null;
  private calls = new Map<number, { id: string; name: string; args: string }>();

  push(delta: Record<string, unknown>, finishReason: string | null): void {
    if (finishReason) this.finish = finishReason;
    const content = delta.content;
    if (typeof content === "string") this.text += content;
    const toolCalls = delta.tool_calls;
    if (!Array.isArray(toolCalls)) return;
    for (const raw of toolCalls) {
      const call = raw as { index?: number; id?: string; function?: { name?: string; arguments?: string } };
      const index = call.index ?? 0;
      const existing = this.calls.get(index) ?? { id: "", name: "", args: "" };
      this.calls.set(index, {
        id: call.id ?? existing.id,
        name: call.function?.name ?? existing.name,
        args: existing.args + (call.function?.arguments ?? ""),
      });
    }
  }

  blocks(): Anthropic.ContentBlock[] {
    const out: Anthropic.ContentBlock[] = [];
    if (this.text !== "") {
      out.push({ type: "text", text: this.text, citations: null } as Anthropic.ContentBlock);
    }
    for (const [index, call] of [...this.calls.entries()].sort((a, b) => a[0] - b[0])) {
      let input: unknown = {};
      try {
        input = call.args.trim() === "" ? {} : JSON.parse(call.args);
      } catch {
        // A provider that streamed malformed arguments gets reported as a tool
        // call with no input rather than crashing the turn; the tool's own
        // validation then produces a message the model can act on.
        input = {};
      }
      out.push({
        type: "tool_use",
        id: call.id || `call_${index}`,
        name: call.name,
        input,
      } as Anthropic.ContentBlock);
    }
    return out;
  }
}

/** True when the accumulated stream produced nothing at all — the shape a
 * provider returns when it rejected the request without an HTTP error. */
function isEmpty(acc: StreamAccumulator): boolean {
  return acc.text === "" && acc.blocks().length === 0;
}

/**
 * What to call the output-token cap.
 *
 * OpenAI's reasoning models — the o-series and the GPT-5 family — REJECT
 * `max_tokens` and require `max_completion_tokens`; every other model, and the
 * compatible gateways, still take `max_tokens`. Sending the wrong one is a 400
 * on the very first message, and the app's default OpenAI model is `gpt-5`.
 *
 * Chosen by model name against the endpoint, not by asking: there is no
 * capability endpoint for this, and a gateway like OpenRouter passes the
 * parameter through to whichever backend it routes to, so the name is the only
 * signal available. Anything unrecognised keeps the widely-accepted spelling.
 */
function tokenLimit(baseUrl: string, model: string, limit: number): Record<string, number> {
  const reasoning = /(^|\/)(o[1-9]|gpt-5)/.test(model);
  const openAiEndpoint = baseUrl.includes("api.openai.com");
  return reasoning && (openAiEndpoint || model.startsWith("openai/"))
    ? { max_completion_tokens: limit }
    : { max_tokens: limit };
}

export async function sendOpenAiCompatible(request: CompatRequest): Promise<CompatReply> {
  const url = `${request.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  // Ollama needs no key. Everything else does, and a blank one is sent as
  // absent rather than as "Bearer ", which some gateways answer with a 500.
  if (request.apiKey !== "") headers.authorization = `Bearer ${request.apiKey}`;
  // OpenRouter asks integrators to identify themselves; it is optional, and
  // sending it keeps the app off their anonymous-traffic rate limits.
  if (url.includes("openrouter.ai")) {
    headers["http-referer"] = "https://likeoffice.app";
    headers["x-title"] = "LikeOffice";
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      signal: request.signal,
      body: JSON.stringify({
        model: request.model,
        messages: toOpenAiMessages(request.system, request.messages),
        tools: toOpenAiTools(request.tools),
        stream: true,
        ...tokenLimit(request.baseUrl, request.model, 16000),
      }),
    });
  } catch (error) {
    return { error: `Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (!response.ok || !response.body) {
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    return { error: `${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}` };
  }

  const acc = new StreamAccumulator();
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      // Server-sent events: "data: {…}" lines, terminated by "data: [DONE]".
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        // Annotating JSON.parse is an assertion with no `as` to mark it — the
        // value is whatever the provider streamed. Parsed as unknown and
        // narrowed, so a malformed frame is skipped rather than trusted.
        let parsed: { choices?: unknown; error?: unknown };
        try {
          parsed = JSON.parse(payload) as { choices?: unknown; error?: unknown };
        } catch {
          continue; // keep-alive or a comment frame
        }
        if (parsed.error) {
          const message = typeof parsed.error === "string"
            ? parsed.error
            : JSON.stringify(parsed.error).slice(0, 500);
          return { error: message };
        }
        const choices: { delta?: Record<string, unknown>; finish_reason?: string | null }[] =
          Array.isArray(parsed.choices) ? parsed.choices : [];
        const choice = choices[0];
        if (!choice || typeof choice !== "object") continue;
        const before = acc.text.length;
        acc.push(choice.delta ?? {}, choice.finish_reason ?? null);
        if (acc.text.length > before) request.onText(acc.text.slice(before));
      }
    }
  } catch (error) {
    if (request.signal?.aborted) return { content: acc.blocks(), stopReason: null };
    return { error: error instanceof Error ? error.message : String(error) };
  }

  if (isEmpty(acc)) {
    return { error: "The provider returned an empty response. Check the model name and that the key has access to it." };
  }
  return { content: acc.blocks(), stopReason: toStopReason(acc.finish) };
}

/** Exposed for the unit spec; not part of the module's contract. */
export const __testing = { tokenLimit };
