/**
 * Runtime execution context used by the scheduler to carry held keys across
 * async callback boundaries. The application owns only this small contract;
 * Node's async-local implementation is injected by infrastructure.
 */
export interface MutationExecutionContext {
  current(): ReadonlySet<string> | undefined;
  run<T>(keys: ReadonlySet<string>, work: () => T): T;
}
