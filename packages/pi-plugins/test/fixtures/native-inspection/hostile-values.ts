export const NativeInspectionLeakageCanaries = Object.freeze({
  control: "native\u001b]8;;https://evil.invalid\u0007key\u001b]8;;\u0007",
  bidi: "safe\u202Egpj.exe\u2066",
  combining: "e\u0301\u200B\u200D",
  path: "/home/alice/.pi/plugin-host/content/SECRET_PATH_CANARY",
  projectRoot: "file:///home/alice/private-project/",
  url: "https://user:password@example.invalid/mcp?token=SECRET_QUERY_CANARY#SECRET_FRAGMENT_CANARY",
  command: "node\u001b[31m",
  argument: "${PLUGIN_ROOT}/bin/server\n--forged",
  headerValue: "SECRET_HEADER_CANARY",
  environmentValue: "SECRET_ENVIRONMENT_CANARY",
  secretLocator: `secret-v1:sha256:${"ab".repeat(32)}`,
  nativeCause: "SECRET_NATIVE_CAUSE stderr=/home/alice/private",
});
