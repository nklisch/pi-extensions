import {
  MutationSubjectSchema,
  type KeyedMutationScheduler,
  type MutationSubject,
} from "./mutation-coordination.js";
import "../domain/state/scope.js";
import type { MutationExecutionContext } from "./ports/mutation-execution-context.js";

const encoder = new TextEncoder();

type Waiter = {
  readonly token: symbol;
  readonly keys: readonly string[];
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal;
  settled: boolean;
  abortListener: (() => void) | undefined;
};

type KeyState = {
  readonly queue: Waiter[];
  owner: Waiter | undefined;
};

/**
 * A callback can retain the scheduler and request another key while it is
 * already holding one. Waiting for an overlapping key would deadlock forever,
 * so this error is raised at the recursive call site before a waiter exists.
 */
export class RecursiveMutationAcquisitionError extends Error {
  readonly code = "RECURSIVE_MUTATION_ACQUISITION" as const;

  constructor() {
    super("mutation scheduler does not permit overlapping recursive acquisition");
    this.name = "RecursiveMutationAcquisitionError";
  }
}

function assertSignal(signal: AbortSignal): void {
  if (
    signal === null ||
    typeof signal !== "object" ||
    typeof signal.addEventListener !== "function" ||
    typeof signal.removeEventListener !== "function" ||
    typeof signal.aborted !== "boolean"
  ) {
    throw new TypeError("mutation scheduling requires an AbortSignal");
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

function field(value: string): string {
  return `${encoder.encode(value).byteLength}:${value}`;
}

/**
 * This encoding is deliberately length-prefixed. Delimiter concatenation would
 * make a future scope/plugin grammar change capable of aliasing two lock keys.
 */
function canonicalSubjectKey(subject: MutationSubject): string {
  const scope = subject.scope;
  return scope.kind === "user"
    ? `scope:${field("user")}|plugin:${field(subject.plugin)}`
    : `scope:${field("project")}${field(scope.projectKey)}|plugin:${field(subject.plugin)}`;
}

function canonicalScopeKey(subject: MutationSubject): string {
  return subject.scope.kind === "user"
    ? `scope:${field("user")}`
    : `scope:${field("project")}${field(subject.scope.projectKey)}`;
}

function compareKeys(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}

function validateSubjects(input: readonly MutationSubject[]): readonly MutationSubject[] {
  if (!Array.isArray(input)) throw new TypeError("mutation subjects must be an array");
  const subjects = input.map((subject) => MutationSubjectSchema.parse(subject));
  const scope = subjects[0] === undefined ? undefined : canonicalScopeKey(subjects[0]);
  const keys = new Set<string>();
  for (const subject of subjects) {
    if (scope !== undefined && canonicalScopeKey(subject) !== scope) {
      throw new TypeError("a mutation request must contain one scope");
    }
    const key = canonicalSubjectKey(subject);
    if (keys.has(key)) throw new TypeError("a mutation request cannot contain duplicate subjects");
    keys.add(key);
  }
  return [...subjects].sort((left, right) =>
    compareKeys(canonicalSubjectKey(left), canonicalSubjectKey(right)));
}

function removeWaiter(state: KeyState, waiter: Waiter): void {
  const index = state.queue.indexOf(waiter);
  if (index !== -1) state.queue.splice(index, 1);
}

function createSynchronousExecutionContext(): MutationExecutionContext {
  let currentKeys: ReadonlySet<string> | undefined;
  return {
    current: () => currentKeys,
    run<T>(keys: ReadonlySet<string>, work: () => T): T {
      const previous = currentKeys;
      currentKeys = keys;
      try {
        return work();
      } finally {
        currentKeys = previous;
      }
    },
  };
}

class Scheduler implements KeyedMutationScheduler {
  private readonly states = new Map<string, KeyState>();

  constructor(private readonly execution: MutationExecutionContext) {}

  run<T>(subjects: readonly MutationSubject[], work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (typeof work !== "function") throw new TypeError("mutation work must be a function");
    const validated = validateSubjects(subjects);
    const heldKeys = this.execution.current();
    if (heldKeys !== undefined && validated.some((subject) => heldKeys.has(canonicalSubjectKey(subject)))) {
      throw new RecursiveMutationAcquisitionError();
    }
    return this.runInternal(validated, work, signal);
  }

  private runInternal<T>(
    subjects: readonly MutationSubject[],
    work: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    assertSignal(signal);
    if (typeof work !== "function") throw new TypeError("mutation work must be a function");
    throwIfAborted(signal);

    const keys = subjects.map(canonicalSubjectKey);
    if (keys.length === 0) {
      return Promise.resolve().then(async () => {
        throwIfAborted(signal);
        return this.execution.run(new Set(this.execution.current() ?? []), work);
      });
    }

    return this.acquire(keys, signal).then(async (waiter) => {
      try {
        throwIfAborted(signal);
        const heldKeys = new Set(this.execution.current() ?? []);
        for (const key of keys) heldKeys.add(key);
        return await this.execution.run(heldKeys, work);
      } finally {
        this.release(waiter);
      }
    });
  }

  private acquire(keys: readonly string[], signal: AbortSignal): Promise<Waiter> {
    let waiter!: Waiter;
    const promise = new Promise<Waiter>((resolve, reject) => {
      waiter = {
        token: Symbol("mutation-owner"),
        keys,
        resolve: () => resolve(waiter),
        reject,
        signal,
        settled: false,
        abortListener: undefined,
      };
    });

    for (const key of keys) {
      const state = this.states.get(key) ?? { queue: [], owner: undefined };
      this.states.set(key, state);
      state.queue.push(waiter);
    }

    waiter.abortListener = () => this.cancel(waiter);
    signal.addEventListener("abort", waiter.abortListener, { once: true });
    if (signal.aborted) {
      this.cancel(waiter);
    } else {
      this.pump(keys);
    }
    return promise;
  }

  private cancel(waiter: Waiter): void {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.abortListener !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
      waiter.abortListener = undefined;
    }
    for (const key of waiter.keys) {
      const state = this.states.get(key);
      if (state !== undefined) removeWaiter(state, waiter);
    }
    waiter.reject(waiter.signal.reason);
    this.pump(waiter.keys);
  }

  private pump(keys: readonly string[]): void {
    for (const key of keys) this.pumpOne(key);
    for (const key of keys) this.cleanup(key);
  }

  private pumpOne(key: string): void {
    const state = this.states.get(key);
    const candidate = state?.queue[0];
    if (state === undefined || candidate === undefined || state.owner !== undefined) return;

    const ready = candidate.keys.every((candidateKey) => {
      const candidateState = this.states.get(candidateKey);
      return candidateState !== undefined && candidateState.owner === undefined && candidateState.queue[0] === candidate;
    });
    if (!ready) return;

    candidate.settled = true;
    if (candidate.abortListener !== undefined) {
      candidate.signal.removeEventListener("abort", candidate.abortListener);
      candidate.abortListener = undefined;
    }
    for (const candidateKey of candidate.keys) {
      const candidateState = this.states.get(candidateKey);
      if (candidateState === undefined) throw new Error("scheduler key state disappeared");
      candidateState.queue.shift();
      candidateState.owner = candidate;
    }
    candidate.resolve();
  }

  private release(waiter: Waiter): void {
    for (const key of [...waiter.keys].reverse()) {
      const state = this.states.get(key);
      if (state?.owner === waiter) state.owner = undefined;
    }
    this.pump(waiter.keys);
  }

  private cleanup(key: string): void {
    const state = this.states.get(key);
    if (state !== undefined && state.owner === undefined && state.queue.length === 0) {
      this.states.delete(key);
    }
  }
}

export function createKeyedMutationScheduler(execution?: MutationExecutionContext): KeyedMutationScheduler {
  const context = execution ?? createSynchronousExecutionContext();
  if (context === null || typeof context !== "object" || typeof context.current !== "function" || typeof context.run !== "function") {
    throw new TypeError("mutation scheduler execution context is required");
  }
  return new Scheduler(context);
}

export { canonicalSubjectKey };
