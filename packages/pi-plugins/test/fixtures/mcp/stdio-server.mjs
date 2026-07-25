import { createInterface } from "node:readline";

const label = process.argv[2] ?? "fixture";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

for await (const line of lines) {
  if (line.length === 0) continue;
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  switch (message.method) {
    case "initialize":
      send(message.id, {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: `fixture-${label}`, version: "1.0.0" },
      });
      break;
    case "tools/list":
      send(message.id, {
        tools: [{
          name: "identity",
          description: "Return the source-qualified fixture identity",
          inputSchema: { type: "object", additionalProperties: false },
        }],
      });
      break;
    case "tools/call":
      send(message.id, {
        content: [{ type: "text", text: label }],
      });
      break;
    case "ping":
      send(message.id, {});
      break;
    default:
      process.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not found" },
      })}\n`);
  }
}
