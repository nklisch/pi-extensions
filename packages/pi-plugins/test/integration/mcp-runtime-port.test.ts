import { defineMcpRuntimeContract } from "../contract/mcp-runtime.contract.js";
import { FakeMcpRuntime } from "../support/fakes/mcp-runtime.js";

defineMcpRuntimeContract("FakeMcpRuntime", () => {
  const runtime = new FakeMcpRuntime();
  return {
    runtime,
    launch: (identity, serverKey, signal, consume) => runtime.launch(identity, serverKey, signal, consume),
    openExecution: (identity, serverKey, signal) => runtime.openExecution(identity, serverKey, signal),
    failNextReplacement: () => runtime.failNextReplacement(),
  };
});
