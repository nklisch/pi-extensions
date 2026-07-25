import { cleanupSuiteArtifact, prepareSuiteArtifact } from "./harness/environment.js";

export default async function setup(): Promise<() => Promise<void>> {
  const artifact = await prepareSuiteArtifact();
  return async () => { await cleanupSuiteArtifact(artifact); };
}
