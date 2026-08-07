#!/usr/bin/env node
/**
 * A minimal MCP stdio server that Codex spawns, proxying every tool request
 * over a unix socket to the LikeOffice main process (which in turn proxies to
 * the renderer holding the live document).
 *
 * stdio side:  MCP JSON-RPC 2.0, newline-delimited (spoken by Codex).
 * socket side: newline-delimited JSON {id, method, params} -> {id, result},
 *              methods listTools / callTool (spoken by src/main/agent.ts).
 */
"use strict";

const net = require("node:net");
const readline = require("node:readline");

const socketPath = process.env.LIKEOFFICE_BRIDGE_SOCKET;
if (!socketPath) {
  process.stderr.write("LIKEOFFICE_BRIDGE_SOCKET is not set\n");
  process.exit(1);
}

const socket = net.createConnection(socketPath);
socket.on("error", (error) => {
  process.stderr.write(`bridge socket error: ${error.message}\n`);
  process.exit(1);
});

// Socket request/response correlation.
let nextSocketId = 1;
const pending = new Map();
let socketBuffer = "";
socket.on("data", (chunk) => {
  socketBuffer += chunk.toString("utf8");
  let newline;
  while ((newline = socketBuffer.indexOf("\n")) >= 0) {
    const line = socketBuffer.slice(0, newline);
    socketBuffer = socketBuffer.slice(newline + 1);
    if (line.trim() === "") continue;
    try {
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    } catch {
      // Ignore unparseable socket lines.
    }
  }
});

function callMain(method, params) {
  return new Promise((resolve) => {
    const id = nextSocketId++;
    pending.set(id, resolve);
    socket.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function replyError(id, message) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message } })}\n`,
  );
}

async function handle(request) {
  const { id, method, params } = request;
  if (method === "initialize") {
    reply(id, {
      protocolVersion: (params && params.protocolVersion) || "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "likeoffice-doc", version: "0.0.1" },
    });
    return;
  }
  if (method === "ping") {
    reply(id, {});
    return;
  }
  if (method === "tools/list") {
    const response = await callMain("listTools", {});
    reply(id, response.result || { tools: [] });
    return;
  }
  if (method === "tools/call") {
    const response = await callMain("callTool", {
      name: params && params.name,
      arguments: (params && params.arguments) || {},
    });
    const outcome = response.result || { content: "Bridge failure", isError: true };
    reply(id, {
      content: [{ type: "text", text: outcome.content }],
      isError: outcome.isError === true,
    });
    return;
  }
  if (id !== undefined && id !== null) {
    replyError(id, `Method not supported: ${method}`);
  }
  // Notifications (no id) are ignored.
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (line.trim() === "") return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  void handle(request).catch((error) => {
    if (request.id !== undefined && request.id !== null) {
      replyError(request.id, String((error && error.message) || error));
    }
  });
});
rl.on("close", () => {
  socket.end();
  process.exit(0);
});
