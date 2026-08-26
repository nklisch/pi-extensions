const module = await import("../dist/index.js");
if (typeof module.createPluginHost !== "function") throw new Error("missing createPluginHost export");
if (typeof module.assertSafeRelativePath !== "function") throw new Error("missing path helper export");
console.log("compiled package import ok");
