const module = await import("../dist/pi/index.js");
if (typeof module.default !== "function") throw new Error("missing Pi extension entry");
console.log("compiled Pi package import ok");
