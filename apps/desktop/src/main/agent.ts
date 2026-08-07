import { app, ipcMain, type WebContents } from "electron";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { cliEnv } from "./providers";
import { readSettings } from "./settings";

/** Matches the renderer loop's cap so both providers stop at the same point. */
const MAX_TURNS = 30;
/** Codex has no documented turn-limit option, so a wall clock is the backstop. */
const CODEX_TIMEOUT_MS = 5 * 60 * 1000;

interface AgentToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AgentRunRequest {
  sessionId: string;
  system: string;
  prompt: string;
  tools: AgentToolDefinition[];
}

interface ToolOutcome {
  content: string;
  isError: boolean;
}

interface Session {
  sessionId: string;
  sender: WebContents;
  abort: AbortController;
  /** Renderer tool calls awaiting an agent:tool-result reply. */
  pending: Map<string, (outcome: ToolOutcome) => void>;
  /** Teardown beyond abort: socket servers, child processes, temp files. */
  cleanups: Array<() => void>;
}

// One in-flight session per window, keyed by webContents id.
const sessions = new Map<number, Session>();

function emit(session: Session, event: Record<string, unknown>): void {
  if (!session.sender.isDestroyed()) {
    session.sender.send("agent:event", { sessionId: session.sessionId, ...event });
  }
}

/** Proxy one tool call to the renderer, where the live document and the
 * engine's tool.execute() live, and wait for the result to come back. */
function callRendererTool(session: Session, name: string, input: unknown): Promise<ToolOutcome> {
  return new Promise((resolve) => {
    if (session.sender.isDestroyed() || session.abort.signal.aborted) {
      resolve({ content: "The document session is closed.", isError: true });
      return;
    }
    const callId = randomUUID();
    session.pending.set(callId, resolve);
    session.sender.send("agent:tool-call", {
      sessionId: session.sessionId,
      callId,
      name,
      input,
    });
  });
}

/** The document tools as an in-process MCP server. Raw JSON schemas from the
 * engine go straight through via low-level handlers - no Zod round trip. */
function documentMcpServer(session: Session, tools: AgentToolDefinition[]): McpServer {
  const mcp = new McpServer(
    { name: "doc", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.input_schema,
    })),
  }));
  mcp.server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const outcome = await callRendererTool(session, req.params.name, req.params.arguments ?? {});
    return {
      content: [{ type: "text" as const, text: outcome.content }],
      isError: outcome.isError,
    };
  });
  return mcp;
}

async function scratchCwd(): Promise<string> {
  // An empty, dedicated directory: the agent gets no filesystem tools, and an
  // empty cwd keeps CLAUDE.md/config auto-discovery from picking anything up.
  const dir = path.join(app.getPath("userData"), "agent-scratch");
  await mkdir(dir, { recursive: true });
  return dir;
}

function describeResult(message: Extract<SDKMessage, { type: "result" }>): string {
  if (message.subtype === "success") return "";
  if (message.subtype === "error_max_turns") return `Stopped after ${MAX_TURNS} tool rounds.`;
  const detail = "errors" in message && message.errors.length > 0 ? ` ${message.errors[0]}` : "";
  return `The Claude session failed (${message.subtype}).${detail}`;
}

/** Run one turn through the Claude Agent SDK, which authenticates via the
 * user's Claude Code login. Built-in tools are disabled; the document tools
 * are the only surface. */
async function runClaude(
  session: Session,
  request: AgentRunRequest,
  model: string,
): Promise<{ error?: string }> {
  const mcp = documentMcpServer(session, request.tools);
  const q = query({
    prompt: request.prompt,
    options: {
      systemPrompt: request.system,
      mcpServers: { doc: { type: "sdk", name: "doc", instance: mcp } },
      // No built-in tools: no filesystem, no shell - document tools only.
      tools: [],
      // ToolSearch stays allowed: the CLI defers MCP tool schemas behind it.
      allowedTools: ["ToolSearch", "mcp__doc__*"],
      permissionMode: "dontAsk",
      maxTurns: MAX_TURNS,
      model,
      cwd: await scratchCwd(),
      abortController: session.abort,
      includePartialMessages: true,
      env: cliEnv(),
    },
  });

  try {
    for await (const message of q) {
      if (session.abort.signal.aborted) break;
      if (message.type === "stream_event") {
        const ev = message.event;
        if (
          ev.type === "content_block_delta" &&
          ev.delta.type === "text_delta" &&
          message.parent_tool_use_id === null
        ) {
          emit(session, { type: "delta", text: ev.delta.text });
        }
      } else if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.trim() !== "") {
            emit(session, { type: "assistant", text: block.text });
          }
        }
      } else if (message.type === "result") {
        const error = describeResult(message);
        return error ? { error } : {};
      }
    }
  } catch (error) {
    if (session.abort.signal.aborted) return {};
    const text = error instanceof Error ? error.message : String(error);
    return { error: `Claude session error: ${text}` };
  }
  return {};
}

/** Serve the document tools to an external MCP client (the Codex-spawned
 * bridge script) over a unix socket speaking newline-delimited JSON:
 * {id, method: "listTools"|"callTool", params} -> {id, result}. */
function serveBridgeSocket(
  session: Session,
  tools: AgentToolDefinition[],
  socketPath: string,
): Promise<void> {
  const server = net.createServer((conn) => {
    let buffer = "";
    conn.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() === "") continue;
        void handleBridgeRequest(session, tools, line).then((reply) => {
          if (!conn.destroyed) conn.write(`${JSON.stringify(reply)}\n`);
        });
      }
    });
    conn.on("error", () => conn.destroy());
  });
  session.cleanups.push(() => {
    server.close();
    void rm(socketPath, { force: true });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
}

async function handleBridgeRequest(
  session: Session,
  tools: AgentToolDefinition[],
  line: string,
): Promise<Record<string, unknown>> {
  let message: { id?: unknown; method?: string; params?: { name?: string; arguments?: unknown } };
  try {
    message = JSON.parse(line);
  } catch {
    return { id: null, error: "Unparseable bridge request" };
  }
  if (message.method === "listTools") {
    return {
      id: message.id,
      result: {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.input_schema,
        })),
      },
    };
  }
  if (message.method === "callTool" && typeof message.params?.name === "string") {
    const outcome = await callRendererTool(
      session,
      message.params.name,
      message.params.arguments ?? {},
    );
    return { id: message.id, result: outcome };
  }
  return { id: message.id, error: `Unknown bridge method ${message.method}` };
}

function bridgeScriptPath(): string {
  return path.join(app.getAppPath(), "resources/codex-mcp-bridge.cjs");
}

/** TOML inline table for `codex exec -c`: points Codex's MCP config at the
 * bridge script, run by this Electron binary in node mode. JSON string
 * escaping is valid TOML basic-string escaping for these values. */
function codexMcpOverride(socketPath: string): string {
  const parts = [
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(bridgeScriptPath())}]`,
    `env = { ELECTRON_RUN_AS_NODE = "1", LIKEOFFICE_BRIDGE_SOCKET = ${JSON.stringify(socketPath)} }`,
  ];
  return `mcp_servers.doc={ ${parts.join(", ")} }`;
}

/** Extract assistant text from one line of `codex exec --json` output.
 * Tolerant of both the current item.completed shape and the older msg shape. */
function codexAssistantText(line: string): string | null {
  let event: {
    type?: string;
    item?: { type?: string; item_type?: string; text?: string };
    msg?: { type?: string; message?: string };
  };
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  const itemType = event.item?.type ?? event.item?.item_type;
  if (
    event.type === "item.completed" &&
    (itemType === "agent_message" || itemType === "assistant_message") &&
    typeof event.item?.text === "string"
  ) {
    return event.item.text;
  }
  if (event.msg?.type === "agent_message" && typeof event.msg.message === "string") {
    return event.msg.message;
  }
  return null;
}

/** Run one turn through `codex exec`, authenticated by the user's ChatGPT
 * sign-in. The sandbox is read-only in an empty temp dir; the document tools
 * reach Codex over MCP via the bridge script and unix socket. */
async function runCodex(session: Session, request: AgentRunRequest): Promise<{ error?: string }> {
  const socketPath = path.join(os.tmpdir(), `likeoffice-${randomUUID().slice(0, 8)}.sock`);
  await serveBridgeSocket(session, request.tools, socketPath);

  const cwd = await mkdtemp(path.join(os.tmpdir(), "likeoffice-codex-"));
  session.cleanups.push(() => void rm(cwd, { recursive: true, force: true }));
  const lastMessageFile = path.join(cwd, "last-message.txt");

  // Codex exec has no separate system-prompt option; fold it into the prompt.
  const prompt = `${request.system}\n\n${request.prompt}`;

  return new Promise((resolve) => {
    const child = spawn(
      "codex",
      [
        "exec",
        "--json",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--output-last-message",
        lastMessageFile,
        "-c",
        codexMcpOverride(socketPath),
        prompt,
      ],
      { cwd, env: cliEnv() },
    );
    session.cleanups.push(() => child.kill());
    const timeout = setTimeout(() => child.kill(), CODEX_TIMEOUT_MS);
    session.abort.signal.addEventListener("abort", () => child.kill(), { once: true });

    let sawAssistantText = false;
    let stdoutBuffer = "";
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      let newline;
      while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
        const text = codexAssistantText(stdoutBuffer.slice(0, newline));
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (text !== null && text.trim() !== "") {
          sawAssistantText = true;
          emit(session, { type: "assistant", text });
        }
      }
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2000);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        error: `Could not start the Codex CLI (${error.message}). Install it with: npm install -g @openai/codex`,
      });
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      void (async () => {
        if (session.abort.signal.aborted) {
          resolve({});
          return;
        }
        if (code !== 0) {
          resolve({ error: `Codex exited with code ${code}. ${stderr.trim()}`.trim() });
          return;
        }
        if (!sawAssistantText) {
          // The --json event shape drifted or was silent; the final message
          // file is the documented fallback.
          try {
            const last = (await readFile(lastMessageFile, "utf8")).trim();
            if (last !== "") emit(session, { type: "assistant", text: last });
          } catch {
            // No final message; the transcript keeps the tool entries.
          }
        }
        resolve({});
      })();
    });
  });
}

function endSession(session: Session): void {
  session.abort.abort();
  for (const resolve of session.pending.values()) {
    resolve({ content: "The session was cancelled.", isError: true });
  }
  session.pending.clear();
  for (const cleanup of session.cleanups.splice(0)) {
    try {
      cleanup();
    } catch {
      // Best-effort teardown.
    }
  }
  if (sessions.get(session.sender.id) === session) sessions.delete(session.sender.id);
}

ipcMain.handle("agent:run", async (event, request: AgentRunRequest): Promise<{ error?: string }> => {
  const previous = sessions.get(event.sender.id);
  if (previous) endSession(previous);

  const session: Session = {
    sessionId: request.sessionId,
    sender: event.sender,
    abort: new AbortController(),
    pending: new Map(),
    cleanups: [],
  };
  sessions.set(event.sender.id, session);
  const onDestroyed = () => endSession(session);
  event.sender.once("destroyed", onDestroyed);

  try {
    const settings = await readSettings();
    if (settings.provider === "claude-subscription") {
      return await runClaude(session, request, settings.model);
    }
    if (settings.provider === "codex-subscription") {
      return await runCodex(session, request);
    }
    return { error: `Provider ${settings.provider} does not run agent sessions.` };
  } finally {
    event.sender.off("destroyed", onDestroyed);
    endSession(session);
  }
});

ipcMain.on("agent:tool-result", (event, result: { callId: string; content: string; isError: boolean }) => {
  const session = sessions.get(event.sender.id);
  const resolve = session?.pending.get(result.callId);
  if (session && resolve) {
    session.pending.delete(result.callId);
    resolve({ content: result.content, isError: result.isError });
  }
});

ipcMain.on("agent:cancel", (event) => {
  const session = sessions.get(event.sender.id);
  if (session) endSession(session);
});
