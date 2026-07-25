import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const identity = Object.freeze({
  revision: process.env.BUNDLE_REVISION,
  root: process.env.BUNDLE_ROOT,
  data: process.env.BUNDLE_DATA,
  channel: process.env.BUNDLE_CHANNEL,
});
appendFileSync(`${identity.data}/production-mcp.jsonl`, `${JSON.stringify({ event: "started", revision: identity.revision })}\n`);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
for await (const line of lines) {
  if (line.length === 0) continue;
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  if (message.method === "initialize") {
    send(message.id, { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "production-bundle", version: identity.revision } });
  } else if (message.method === "tools/list") {
    send(message.id, { tools: [{ name: "identity", description: "Return late-bound production bundle identity", inputSchema: { type: "object", additionalProperties: false } }] });
  } else if (message.method === "tools/call") {
    const result = { content: [{ type: "text", text: JSON.stringify(identity) }] };
    if (message.params?.arguments?.delay === true) setTimeout(() => send(message.id, result), 60_000).unref();
    else send(message.id, result);
  } else if (message.method === "ping") send(message.id, {});
  else process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })}\n`);
}
