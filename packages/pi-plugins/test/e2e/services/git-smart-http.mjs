import { spawn } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:https";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`git smart-HTTP fixture requires ${name}`);
  return value;
};

const port = Number.parseInt(required("E2E_GIT_PORT"), 10);
const repositoryRoot = required("E2E_GIT_PROJECT_ROOT");
const backend = required("E2E_GIT_HTTP_BACKEND");
const phaseFile = required("E2E_GIT_PHASE_FILE");
const requestFile = required("E2E_GIT_REQUEST_FILE");
const controlFile = required("E2E_GIT_CONTROL_FILE");
const key = await readFile(required("E2E_GIT_TLS_KEY"));
const cert = await readFile(required("E2E_GIT_TLS_CERT"));
let sequence = 0;
const children = new Set();
let recordTail = Promise.resolve();
let faultTail = Promise.resolve();

function record(file, value) {
  // Concurrent smart-HTTP requests must not race independent appendFile opens:
  // a lost/rejected diagnostic write would otherwise strand the request before
  // its backend is wired, turning fixture observability into a network hang.
  const write = recordTail.then(() => appendFile(file, `${JSON.stringify({ at: Date.now(), ...value })}\n`));
  recordTail = write.catch(() => undefined);
  return write;
}

function parseHeaders(bytes) {
  const crlf = bytes.indexOf("\r\n\r\n");
  const lf = crlf < 0 ? bytes.indexOf("\n\n") : -1;
  const end = crlf >= 0 ? crlf + 4 : lf >= 0 ? lf + 2 : -1;
  if (end < 0) return undefined;
  const text = bytes.subarray(0, end).toString("utf8").replaceAll("\r", "");
  const headers = {};
  let status = 200;
  for (const line of text.split("\n").filter(Boolean)) {
    const split = line.indexOf(":");
    if (split < 0) continue;
    const name = line.slice(0, split).trim();
    const value = line.slice(split + 1).trim();
    if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
    else headers[name] = value;
  }
  return { end, status, headers };
}

function takeFaultMode() {
  // "next" is a single-consumer instruction even when Git starts concurrent
  // discovery requests. Serialize read-and-clear as one fixture transaction.
  const take = faultTail.then(async () => {
    const command = await readFile(controlFile, "utf8").catch(() => "");
    const mode = command.includes("close-next") ? "close" : command.includes("pause-next") ? "pause" : "none";
    if (mode !== "none") await writeFile(controlFile, "");
    return mode;
  });
  faultTail = take.then(() => undefined, () => undefined);
  return take;
}

const server = createServer({ key, cert }, async (request, response) => {
  const id = ++sequence;
  const url = new URL(request.url ?? "/", `https://${request.headers.host ?? "127.0.0.1"}`);
  const protocolHeader = request.headers["git-protocol"];
  const gitProtocol = Array.isArray(protocolHeader) ? protocolHeader[0] : protocolHeader;
  if (gitProtocol !== undefined && gitProtocol !== "version=2") {
    await record(phaseFile, { id, phase: "protocol-rejected" });
    response.writeHead(400, { "content-type": "text/plain" });
    response.end("Unsupported Git protocol\n");
    return;
  }
  await record(requestFile, { id, method: request.method, path: url.pathname, query: url.search.slice(1), protocol: gitProtocol ?? "unspecified" });
  await record(phaseFile, { id, phase: "request-start" });
  const faultMode = await takeFaultMode();
  if (faultMode === "close") {
    await record(phaseFile, { id, phase: "connection-close" });
    request.socket.destroy();
    return;
  }

  const child = spawn(backend, [], {
    env: {
      PATH: process.env.PATH,
      GIT_PROJECT_ROOT: repositoryRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      REQUEST_METHOD: request.method ?? "GET",
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: request.headers["content-type"] ?? "",
      CONTENT_LENGTH: request.headers["content-length"] ?? "",
      REMOTE_ADDR: request.socket.remoteAddress ?? "127.0.0.1",
      SERVER_PROTOCOL: `HTTP/${request.httpVersion}`,
      SERVER_NAME: "127.0.0.1",
      SERVER_PORT: String(port),
      ...(gitProtocol === undefined ? {} : { GIT_PROTOCOL: gitProtocol }),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  await record(phaseFile, { id, phase: "backend-start", pid: child.pid });
  if (faultMode === "pause") {
    child.kill("SIGSTOP");
    await record(phaseFile, { id, phase: "backend-paused", pid: child.pid });
  }
  request.pipe(child.stdin);
  request.once("aborted", () => child.kill("SIGKILL"));

  let buffered = Buffer.alloc(0);
  let headersSent = false;
  child.stdout.on("data", (chunk) => {
    if (headersSent) {
      response.write(chunk);
      return;
    }
    buffered = Buffer.concat([buffered, chunk]);
    const parsed = parseHeaders(buffered);
    if (!parsed) return;
    headersSent = true;
    response.writeHead(parsed.status, parsed.headers);
    response.write(buffered.subarray(parsed.end));
    buffered = Buffer.alloc(0);
    void record(phaseFile, { id, phase: "backend-headers", status: parsed.status });
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { if (stderr.length < 16_384) stderr += chunk; });
  child.once("error", (error) => {
    children.delete(child);
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
    response.end("Git service unavailable\n");
    void record(phaseFile, { id, phase: "backend-error", message: error.message });
  });
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!headersSent && !response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
    response.end();
    void record(phaseFile, { id, phase: "backend-exit", code, signal, stderr });
  });
});

server.listen({ host: "127.0.0.1", port, exclusive: true }, async () => {
  await record(phaseFile, { phase: "ready", port });
  process.stdout.write(`${JSON.stringify({ type: "ready", port })}\n`);
});
server.on("error", (error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});

async function close() {
  for (const child of children) child.kill("SIGCONT");
  for (const child of children) child.kill("SIGTERM");
  await new Promise((resolve) => server.close(resolve));
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => { void close().finally(() => process.exit(0)); });
}
