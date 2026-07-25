import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  MarketplaceNameSchema,
  PluginIdentitySchema,
  PluginKeySchema,
  PluginNameSchema,
  createPluginIdentity,
  formatPluginKey,
  parsePluginKey,
  type MarketplaceName,
  type PluginIdentity,
  type PluginKey,
  type PluginName,
} from "../../src/domain/identity.js";

describe("plugin identities", () => {
  it.each([
    ["plugin", "marketplace"],
    ["plugin.v2", "marketplace-name"],
    ["A_plugin-2", "M.1"],
  ])("round-trips %s@%s", (plugin, marketplace) => {
    const pluginName = PluginNameSchema.parse(plugin);
    const marketplaceName = MarketplaceNameSchema.parse(marketplace);
    const key = formatPluginKey(pluginName, marketplaceName);

    expect(key).toBe(`${plugin}@${marketplace}`);
    expect(parsePluginKey(key)).toEqual({
      plugin: pluginName,
      marketplace: marketplaceName,
    });
  });

  it.each([
    ["", "marketplace", "empty plugin"],
    ["plugin", "", "empty marketplace"],
    [" plugin", "marketplace", "leading whitespace"],
    ["plugin", "market place", "embedded whitespace"],
    ["plugin@other", "marketplace", "plugin delimiter"],
    ["plugin", "marketplace/other", "slash"],
    ["é", "marketplace", "unicode confusable"],
    ["plugin", "marketplace\n", "control character"],
  ])("rejects %s and %s (%s)", (plugin, marketplace) => {
    expect(
      PluginNameSchema.safeParse(plugin).success &&
        MarketplaceNameSchema.safeParse(marketplace).success,
    ).toBe(false);
    expect(() =>
      formatPluginKey(
        plugin as PluginName,
        marketplace as MarketplaceName,
      ),
    ).toThrow();
  });

  it.each([
    "plugin",
    "@marketplace",
    "plugin@",
    "plugin@@marketplace",
    "plugin@market place",
    "plugin@marketplace/other",
    "plugin@marketplace\n",
  ])("rejects malformed key %s", (input) => {
    expect(PluginKeySchema.safeParse(input).success).toBe(false);
    expect(() => parsePluginKey(input)).toThrow();
  });

  it("rejects an identity whose key disagrees with its components", () => {
    const result = PluginIdentitySchema.safeParse({
      key: "other@marketplace",
      marketplaceName: "marketplace",
      marketplaceEntryName: "plugin",
    });

    expect(result.success).toBe(false);
    expect(() =>
      createPluginIdentity({
        key: "other@marketplace",
        marketplaceName: "marketplace",
        marketplaceEntryName: "plugin",
      }),
    ).toThrow();
  });

  it("retains an optional manifest name without changing lookup identity", () => {
    const identity = createPluginIdentity({
      key: "entry@marketplace",
      marketplaceName: "marketplace",
      marketplaceEntryName: "entry",
      manifestName: "internal-name",
    });

    expect(identity).toEqual({
      key: "entry@marketplace",
      marketplaceName: "marketplace",
      marketplaceEntryName: "entry",
      manifestName: "internal-name",
    });
  });

  it("derives public types from the schemas", () => {
    expectTypeOf<z.infer<typeof MarketplaceNameSchema>>().toEqualTypeOf<
      MarketplaceName
    >();
    expectTypeOf<z.infer<typeof PluginNameSchema>>().toEqualTypeOf<PluginName>();
    expectTypeOf<z.infer<typeof PluginKeySchema>>().toEqualTypeOf<PluginKey>();
    expectTypeOf<z.infer<typeof PluginIdentitySchema>>().toEqualTypeOf<
      PluginIdentity
    >();

    const plugin = PluginNameSchema.parse("plugin");
    const marketplace = MarketplaceNameSchema.parse("marketplace");
    expectTypeOf(formatPluginKey(plugin, marketplace)).toEqualTypeOf<PluginKey>();
    expectTypeOf(parsePluginKey("plugin@marketplace").plugin).toEqualTypeOf<
      PluginName
    >();
  });
});
