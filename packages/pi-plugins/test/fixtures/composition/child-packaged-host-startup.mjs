import { createPackagedPluginHost } from "../../../src/composition/create-packaged-plugin-host.js";

const [agentDir, projectRoot, sessionId] = process.argv.slice(2);
const pi = { on() {}, sendMessage() {}, setSessionName() {} };
const context = {
  cwd: projectRoot,
  mode: "interactive",
  sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
  isProjectTrusted: () => true,
};
let networkCalls = 0;
let publisherCalls = 0;
const host = createPackagedPluginHost({
  pi,
  agentDir,
  source: { fetch: async () => { networkCalls += 1; throw new Error("packaged startup called network"); } },
  update: { publisher: { async publish() { publisherCalls += 1; throw new Error("packaged startup called publisher"); } } },
});
try {
  const started = await host.start({ type: "session_start", reason: "startup" }, context);
  process.stdout.write(`${JSON.stringify({ status: started.startup.status, networkCalls, publisherCalls })}\n`);
} finally {
  await host.dispose("quit");
}
