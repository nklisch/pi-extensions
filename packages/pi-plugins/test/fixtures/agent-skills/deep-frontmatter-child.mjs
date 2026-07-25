import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { readBoundedFrontmatter } = await jiti.import(
  "../../../src/formats/agent-skills/frontmatter-reader.ts",
);

const provenance = {
  location: {
    host: "codex",
    documentKind: "skill",
    path: "skills/adversarial/SKILL.md",
    pointer: "",
  },
};
const nested = `${"[".repeat(6_000)}0${"]".repeat(6_000)}`;
const result = readBoundedFrontmatter(
  `---\nvalue: ${nested}\n---\n# adversarial\n`,
  provenance,
);
const serialized = JSON.stringify(result);
if (result.ok || /(?:call stack|stack overflow|RangeError)/i.test(serialized)) {
  process.stderr.write("deep frontmatter did not fail through the bounded diagnostic contract\n");
  process.exitCode = 1;
} else {
  process.stdout.write(`${serialized}\n`);
}
