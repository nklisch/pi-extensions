import { appendFileSync, readFileSync } from "node:fs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const revision = readFileSync(new URL("../revision.txt", import.meta.url), "utf8").trim();
const evidence = {
  event: input.hook_event_name,
  revision,
  agentId: input.agent_id,
  sessionId: input.pi?.subagent?.sessionId,
  runId: input.pi?.subagent?.runId,
  continuationRound: input.pi?.subagent?.continuationRound,
};
appendFileSync(`${process.env.PLUGIN_DATA}/production-hooks.jsonl`, `${JSON.stringify(evidence)}\n`);
if (input.hook_event_name === "SubagentStart") {
  process.stdout.write(JSON.stringify({ additionalContext: `START_CONTEXT_${revision}` }));
} else if (input.hook_event_name === "SubagentStop" && input.pi?.subagent?.continuationRound === 0) {
  process.stdout.write(JSON.stringify({ additionalContext: `STOP_CONTINUE_${revision}`, continue: false, stopReason: `STOP_CONTINUE_${revision}` }));
}
