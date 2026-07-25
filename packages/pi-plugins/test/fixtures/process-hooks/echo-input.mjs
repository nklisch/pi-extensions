import { readFileSync } from "node:fs";

const input = readFileSync(0, "utf8");
process.stdout.write(JSON.stringify({
  input,
  cwd: process.cwd(),
  env: {
    CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT,
    CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA,
    PLUGIN_ROOT: process.env.PLUGIN_ROOT,
    PLUGIN_DATA: process.env.PLUGIN_DATA,
    CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
    CLAUDE_PLUGIN_OPTION_TOKEN: process.env.CLAUDE_PLUGIN_OPTION_TOKEN,
  },
}));
