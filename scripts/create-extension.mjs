import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { packagesDirectory } from "./package-catalog.mjs";

const [rawName, ...descriptionParts] = process.argv.slice(2);
if (!rawName) {
  console.error('Usage: npm run create:extension -- <name> ["description"]');
  process.exit(2);
}

const shortName = rawName.replace(/^@nklisch\//, "").replace(/^pi-/, "");
if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(shortName)) {
  console.error("Name must be lowercase kebab-case.");
  process.exit(2);
}

const directoryName = `pi-${shortName}`;
const packageName = `@nklisch/${directoryName}`;
const directory = join(packagesDirectory.pathname, directoryName);
const description = descriptionParts.join(" ") || `Pi extension for ${shortName.replaceAll("-", " ")}.`;

try {
  await readFile(join(directory, "package.json"));
  console.error(`${directoryName} already exists.`);
  process.exit(1);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const manifest = {
  name: packageName,
  version: "0.1.0",
  private: false,
  description,
  type: "module",
  author: { name: "Nathan Klisch" },
  license: "MIT",
  repository: {
    type: "git",
    url: "git+https://github.com/nklisch/pi-extensions.git",
    directory: `packages/${directoryName}`,
  },
  bugs: { url: "https://github.com/nklisch/pi-extensions/issues" },
  homepage: `https://github.com/nklisch/pi-extensions/tree/main/packages/${directoryName}#readme`,
  publishConfig: { access: "public", provenance: true },
  keywords: ["pi-package", "pi-extension"],
  pi: { extensions: ["./src/index.ts"] },
  files: ["src", "README.md", "LICENSE"],
  scripts: {
    test: "vitest run",
    typecheck: "tsc --noEmit",
  },
  peerDependencies: {
    "@earendil-works/pi-coding-agent": "*",
  },
  devDependencies: {
    "@earendil-works/pi-coding-agent": "*",
    "@types/node": "^24.0.0",
    typescript: ">=7.0.0 <8",
    vitest: "^4.0.0",
  },
};

await mkdir(join(directory, "src"), { recursive: true });
await mkdir(join(directory, "test"), { recursive: true });
await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(join(directory, "tsconfig.json"), `${JSON.stringify({
  compilerOptions: {
    target: "ES2024",
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  },
  include: ["src/**/*.ts", "test/**/*.ts"],
}, null, 2)}\n`);
await writeFile(join(directory, "src/index.ts"), `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\n\nexport default function extension(pi: ExtensionAPI): void {\n  // Register this package's tools, commands, and lifecycle hooks here.\n  void pi;\n}\n`);
await writeFile(join(directory, "test/index.test.ts"), `import { describe, expect, it } from "vitest";\nimport extension from "../src/index.js";\n\ndescribe("${packageName}", () => {\n  it("exports an extension factory", () => {\n    expect(extension).toBeTypeOf("function");\n  });\n});\n`);
await writeFile(join(directory, "README.md"), `# ${packageName}\n\n${description}\n\n## Install\n\n\`\`\`sh\npi install npm:${packageName}\n\`\`\`\n`);
await writeFile(join(directory, "LICENSE"), "MIT License\n\nCopyright (c) Nathan Klisch\n");

console.log(`Created ${packageName} in packages/${directoryName}.`);
console.log("Run npm install, then npm run check.");
