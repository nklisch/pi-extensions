import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
  detached: false,
});
process.stdout.write(String(child.pid));
setInterval(() => {}, 1000);
