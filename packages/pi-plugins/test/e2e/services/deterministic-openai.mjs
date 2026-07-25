import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

const port = Number.parseInt(process.env.E2E_MODEL_PORT ?? "", 10);
const controlFile = process.env.E2E_MODEL_CONTROL_FILE;
const requestFile = process.env.E2E_MODEL_REQUEST_FILE;
if (!Number.isSafeInteger(port) || !controlFile || !requestFile) throw new Error("deterministic model service configuration is invalid");

let sequence = 0;

function scenario() {
  return readFileSync(controlFile, "utf8").trim() || "mcp";
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) return message.content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n");
  return "";
}

function texts(body) {
  return (Array.isArray(body?.messages) ? body.messages : []).map(messageText);
}

function latestUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return messageText(messages[index]);
  }
  return "";
}

function toolResults(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  let currentUser = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") { currentUser = index; break; }
  }
  return messages.slice(currentUser + 1)
    .filter((message) => message?.role === "tool")
    .map(messageText);
}

// The programmatic MCP gateway renders status as human lines:
// "✓|○|⚠|✗ [plugin · ]<nativeKey> · <serverKey> (<state>)". Server keys are
// source-qualified, so scenarios list/call by key without identity JSON.
function statusServers(results) {
  for (const text of results) {
    const servers = [];
    for (const line of text.split("\n")) {
      const match = /^[✓○⚠✗] (?:\S+ · )?(\S+) · (mcp-server-v1:[0-9a-f]{64})/u.exec(line.trim());
      if (match) servers.push({ nativeKey: match[1], key: match[2] });
    }
    if (servers.length > 0) return servers;
    if (text.includes("no servers configured")) return [];
  }
  throw new Error("MCP status result did not list any servers");
}

function toolCall(name, args) {
  return {
    kind: "tool",
    name,
    arguments: JSON.stringify(args),
  };
}

function responseFor(body) {
  const selected = scenario();
  const allText = texts(body).join("\n");
  const results = toolResults(body);

  if (selected.startsWith("subagent")) {
    const revision = selected.endsWith("v2") ? "v2" : "v1";
    if (results.some((text) => text.includes(`CHILD_FINAL_${revision}`))) {
      return { kind: "text", text: `PARENT_OBSERVED_${revision} ${results.at(-1)}` };
    }
    if (results.some((text) => text.includes("CHILD_UNINJECTED"))) {
      return { kind: "text", text: `PARENT_SUBAGENT_UNINJECTED_${revision}` };
    }
    if (allText.includes(`STOP_CONTINUE_${revision}`)) {
      return { kind: "text", text: `CHILD_FINAL_${revision} SAME_SESSION_CONTINUATION` };
    }
    if (allText.includes(`START_CONTEXT_${revision}`)) {
      return { kind: "text", text: `CHILD_FIRST_${revision}` };
    }
    if (allText.includes(`PRODUCTION_SUBAGENT_JOURNEY_${revision}`) &&
        !body.tools?.some((entry) => entry.function?.name === "subagent")) {
      return { kind: "text", text: "CHILD_UNINJECTED" };
    }
    return toolCall("subagent", {
      prompt: `PRODUCTION_SUBAGENT_JOURNEY_${revision}`,
      description: "production lifecycle proof",
      subagent_type: "general-purpose",
      run_in_background: false,
      inherit_context: false,
    });
  }

  if (selected === "mcp") {
    if (results.length === 0) return toolCall("mcp", { action: "status" });
    const servers = statusServers(results);
    if (servers.length === 0) return { kind: "text", text: "PARENT_MCP_ABSENT" };
    const user = latestUserText(body);
    const failure = user.includes("PRODUCTION_MCP_FAILURE");
    const cancellation = user.includes("PRODUCTION_MCP_CANCEL");
    const selectedServer = servers.find((server) => server.nativeKey === (failure ? "failing" : "identity"));
    if (selectedServer === undefined) throw new Error("selected MCP server was not registered");
    const server = selectedServer.key;
    if (results.length === 1) return toolCall("mcp", { action: "list", server });
    if (failure) return { kind: "text", text: `PARENT_MCP_FAILURE_OBSERVED ${results.at(-1)}` };
    if (results.length === 2) return toolCall("mcp", { action: "call", server, tool: "identity", args: cancellation ? "{\"delay\":true}" : "{}" });
    return { kind: "text", text: `PARENT_MCP_OBSERVED ${results.at(-1)}` };
  }

  return { kind: "text", text: "DETERMINISTIC_SCENARIO_UNAVAILABLE" };
}

function chunk(response) {
  const id = `production-e2e-${++sequence}`;
  const base = { id, object: "chat.completion.chunk", created: 1, model: "production-model" };
  if (response.kind === "tool") {
    return {
      ...base,
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{ index: 0, id: `${id}-tool`, type: "function", function: { name: response.name, arguments: response.arguments } }],
        },
        finish_reason: "tool_calls",
      }],
    };
  }
  return {
    ...base,
    choices: [{ index: 0, delta: { role: "assistant", content: response.text }, finish_reason: "stop" }],
  };
}

const server = createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  let size = 0;
  const parts = [];
  request.on("data", (part) => {
    size += part.length;
    if (size > 1_048_576) request.destroy();
    else parts.push(part);
  });
  request.on("end", () => {
    try {
      const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
      appendFileSync(requestFile, `${JSON.stringify({ scenario: scenario(), roles: body.messages?.map((entry) => entry.role), tools: body.tools?.map((entry) => entry.function?.name) })}\n`);
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
      response.write(`data: ${JSON.stringify(chunk(responseFor(body)))}\n\n`);
      response.end("data: [DONE]\n\n");
    } catch {
      response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "invalid deterministic request" } }));
    }
  });
});

server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
  process.stdout.write(`${JSON.stringify({ type: "ready", port })}\n`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
