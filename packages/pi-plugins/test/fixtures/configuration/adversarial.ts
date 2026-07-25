/** Deliberate leak canaries. These values may appear only inside callback-scoped fakes/tests. */
export const configurationCanaries = Object.freeze({
  string: "CANARY_CONFIGURATION_STRING",
  number: 731,
  boolean: true,
  directory: "file:///trusted/CANARY_DIRECTORY",
  file: "file:///trusted/CANARY_FILE",
  strings: ["CANARY_ARRAY_VALUE"],
  secret: "CANARY_INTEGRATION_SECRET",
});
