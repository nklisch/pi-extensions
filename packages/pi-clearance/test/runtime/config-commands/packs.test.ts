import { describe, expect, it } from "vitest";

import {
  formatPackListMarkdown,
  type DefaultPackListingDetails,
} from "../../../src/runtime/config-commands/packs.ts";

describe("Policy dossier Markdown", () => {
  it("renders pack names without literal HTML and escapes table cells", () => {
    const details = {
      packs: [
        {
          id: "pack|one",
          title: "Read | files",
          availabilityState: "available",
          effectSummary: "allow",
          source: "package",
          inBaseline: false,
        },
      ],
      warnings: [],
      filter: {},
      explorerFilter: {},
      idsPrimary: false,
      verbose: false,
    } as unknown as DefaultPackListingDetails;

    const markdown = formatPackListMarkdown(details);
    expect(markdown).not.toMatch(/<\/?(?:br|small)>/i);
    expect(markdown).toContain("Read \\| files — `pack\\|one`");
  });
});
