import { appendFileSync } from "node:fs";
import { join } from "node:path";

appendFileSync(
  join(process.env.PLUGIN_DATA, "hook-events.log"),
  `${process.env.CLAUDE_PLUGIN_OPTION_GREETING ?? "missing"}|${process.env.PLUGIN_ROOT}|${process.env.CLAUDE_PROJECT_DIR}\n`,
);
