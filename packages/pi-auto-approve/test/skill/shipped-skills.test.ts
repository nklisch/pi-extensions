import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("shipped Pi skills and docs package surface", () => {
  it("ships registered thin skills and canonical docs", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(process.cwd(), "package.json"), "utf8"),
    ) as {
      readonly pi: { readonly skills: readonly string[] };
      readonly files: readonly string[];
    };
    const packAuthoringSkill = await readFile(
      path.join(process.cwd(), "src/skill/clearance-pack-authoring/SKILL.md"),
      "utf8",
    );
    const readme = await readFile(
      path.join(process.cwd(), "README.md"),
      "utf8",
    );
    const developerGuide = await readFile(
      path.join(process.cwd(), "docs/DEVELOPER_GUIDE.md"),
      "utf8",
    );
    const packAuthoring = await readFile(
      path.join(process.cwd(), "docs/PACK_AUTHORING.md"),
      "utf8",
    );

    expect(packageJson.pi.skills).toEqual(
      expect.arrayContaining([
        "./src/skill/clearance-tune/SKILL.md",
        "./src/skill/clearance-pack-authoring/SKILL.md",
      ]),
    );
    expect(packageJson.files).toEqual(
      expect.arrayContaining(["src", "docs", "README.md"]),
    );

    expect(packAuthoringSkill).toContain(
      "[PACK_AUTHORING.md](../../../docs/PACK_AUTHORING.md)",
    );
    expect(packAuthoringSkill).toContain(
      "[CONFIGURATION.md](../../../docs/CONFIGURATION.md)",
    );
    expect(packAuthoringSkill).toContain(
      "[RATCHET.md](../../../docs/RATCHET.md)",
    );
    expect(packAuthoringSkill).toContain(
      "Installing a Pi package makes package packs available",
    );
    expect(packAuthoringSkill).toMatch(
      /does not enable\s+them or relax policy/,
    );
    expect(packAuthoringSkill).toContain(
      "Trusted TypeScript rule modules are cut",
    );
    expect(packAuthoringSkill).toContain("sealed-floor validation");
    expect(packAuthoringSkill).toMatch(/Replay\/validation.*user approval/s);

    expect(readme).toContain("docs/PACK_AUTHORING.md");
    expect(developerGuide).toContain("./src/skill/clearance-tune/SKILL.md");
    expect(developerGuide).toContain(
      "./src/skill/clearance-pack-authoring/SKILL.md",
    );
    expect(packAuthoring).toContain("Package-distributed collection checklist");
    expect(packAuthoring).toContain(
      "Trusted TypeScript rule modules were cut from Pi Clearance",
    );
    expect(packAuthoring).toContain("removed configuration keys fail strict");
  });
});
