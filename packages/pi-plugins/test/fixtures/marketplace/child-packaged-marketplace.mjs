import { createPackagedPluginHost } from "../../../src/composition/create-packaged-plugin-host.js";

const [agentDir, projectRoot, repository, mode, registrationId = ""] = process.argv.slice(2);
if (![agentDir, projectRoot, repository, mode].every((value) => typeof value === "string" && value.length > 0)) throw new Error("marketplace child arguments are required");
const context = {
  cwd: projectRoot,
  mode: "interactive",
  sessionManager: { getSessionId: () => `marketplace-child-${process.pid}`, getSessionFile: () => undefined },
  isProjectTrusted: () => true,
};
const pi = { on() {}, sendMessage() {}, setSessionName() {} };
const host = createPackagedPluginHost({ pi, agentDir });
try {
  await host.start({ type: "session_start", reason: "startup" }, context);
  const result = await host.runWithPiOperationContext(context, new AbortController().signal, async (application) => {
    const signal = new AbortController().signal;
    let argv;
    if (mode === "add") argv = ["marketplace", "add", repository, "--source-kind", "local-git"];
    else if (mode === "refresh") argv = ["marketplace", "refresh", registrationId];
    else if (mode === "remove") argv = ["marketplace", "remove", registrationId, "--yes"];
    else if (mode === "list") argv = ["marketplace", "list"];
    if (argv !== undefined) return (await application.control.runArgv(argv, { mode: "headless", output: "json" }, signal)).envelope.data;
    throw new Error(`unknown marketplace child mode: ${mode}`);
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await host.dispose("quit");
}
