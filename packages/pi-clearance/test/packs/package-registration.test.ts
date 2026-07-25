import { describe, expect, it, vi } from "vitest";
import {
  AUTO_REVIEWER_PACKS_REGISTER_EVENT,
  AUTO_REVIEWER_PACKS_REQUEST_EVENT,
} from "../../src/packs/package-contract.ts";
import {
  createPackageRegistrationStore,
  type PackageRegistrationStore,
} from "../../src/packs/package-registration.ts";
import type { PolicyRule } from "../../src/policy/core.ts";

/**
 * Minimal synchronous event bus for tests. It mirrors the real Pi
 * `EventBus` (`emit`/`on`) in the one property that matters for v1
 * synchronous capture: handler bodies run synchronously during `emit`, before
 * `emit` returns.
 *
 * Pi's real bus wraps every handler in an async `safeHandler` whose `try/catch`
 * swallows per-handler errors (logging to console.error), so a throwing
 * contributor never aborts sibling handlers and never reaches the store's
 * defensive catch. By default this fake propagates handler throws so bugs in
 * the store's own register-event handler surface loudly; pass
 * `swallowHandlerErrors: true` to faithfully model Pi's per-handler isolation
 * (a throwing contributor is skipped and siblings still run).
 */
interface TestEventBus {
  readonly on: (
    channel: string,
    handler: (data: unknown) => void,
  ) => () => void;
  readonly emit: (channel: string, data: unknown) => void;
  readonly handlerCount: (channel: string) => number;
}

function createTestEventBus(
  options: { readonly swallowHandlerErrors?: boolean } = {},
): TestEventBus {
  const swallowHandlerErrors = options.swallowHandlerErrors === true;
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(channel, handler) {
      let set = handlers.get(channel);
      if (set === undefined) {
        set = new Set();
        handlers.set(channel, set);
      }
      set.add(handler);
      return () => {
        const current = handlers.get(channel);
        if (current !== undefined) {
          current.delete(handler);
        }
      };
    },
    emit(channel, data) {
      const set = handlers.get(channel);
      if (set === undefined) {
        return;
      }
      // Copy to a list first so a handler unsubscribing during emit doesn't
      // perturb the iteration.
      for (const handler of [...set]) {
        if (swallowHandlerErrors) {
          try {
            handler(data);
          } catch {
            // Mirrors Pi's event bus: a throwing handler is skipped.
          }
        } else {
          handler(data);
        }
      }
    },
    handlerCount(channel) {
      return handlers.get(channel)?.size ?? 0;
    },
  };
}

/** A valid data-pack contribution with package-supplied provenance to rewrite. */
function dataPackContribution(overrides: Record<string, unknown> = {}) {
  return {
    kind: "data-pack",
    pack: {
      version: 1,
      id: "pack:contrib",
      metadata: { title: "Contributed pack" },
      rules: [
        {
          id: "allow-read",
          effect: "allow",
          match: { tool: "bash" },
          reason: "contributed read rule",
          provenance: { source: "shipped" },
        },
      ],
    },
    ...overrides,
  };
}

/** Register a contributor that listens for the request and emits a payload. */
function registerContributor(
  bus: TestEventBus,
  response: (requestId: string, reason: string) => unknown,
): {
  readonly requests: { readonly requestId: string; readonly reason: string }[];
} {
  const requests: { requestId: string; reason: string }[] = [];
  bus.on(AUTO_REVIEWER_PACKS_REQUEST_EVENT, (data) => {
    const request = data as {
      readonly requestId: string;
      readonly reason: string;
    };
    requests.push({ requestId: request.requestId, reason: request.reason });
    bus.emit(
      AUTO_REVIEWER_PACKS_REGISTER_EVENT,
      response(request.requestId, request.reason),
    );
  });
  return { requests };
}

function registrationPayload(
  requestId: string | undefined,
  packs: unknown[],
  provenance: Record<string, unknown> = {
    name: "demo-pkg",
    installKind: "npm",
  },
): unknown {
  const payload: Record<string, unknown> = {
    apiVersion: 1,
    package: provenance,
    packs,
  };
  if (requestId !== undefined) {
    payload.requestId = requestId;
  }
  return payload;
}

describe("createPackageRegistrationStore event collection", () => {
  it("discovers a package extension responding to the request on startup", () => {
    const bus = createTestEventBus();
    const contributor = registerContributor(bus, (requestId) =>
      registrationPayload(requestId, [dataPackContribution()]),
    );
    const store = createPackageRegistrationStore({ events: bus });

    const snapshot = store.collect("startup");

    // The contributor was asked with a startup reason and a fresh request id.
    expect(contributor.requests).toHaveLength(1);
    expect(contributor.requests[0]?.reason).toBe("startup");
    const requestId = contributor.requests[0]?.requestId;
    expect(typeof requestId).toBe("string");
    expect(snapshot.requestId).toBe(requestId);

    // The contributed data pack was captured with package source and rewritten
    // rule provenance (delegated to the contract normalizer).
    expect(snapshot.packs).toHaveLength(1);
    const pack = snapshot.packs[0]?.pack;
    expect(pack?.id).toBe("pack:contrib");
    expect(snapshot.packs[0]?.source.kind).toBe("package");
    expect(snapshot.packs[0]?.source.packageName).toBe("demo-pkg");
    const rule = pack?.rules[0] as PolicyRule | undefined;
    expect(rule?.provenance).toEqual({
      source: "package",
      packId: "pack:contrib",
      ruleId: "allow-read",
    });
    expect(snapshot.issues).toEqual([]);
  });

  it("captures multiple contributors independently in one collect", () => {
    const bus = createTestEventBus();
    bus.on(AUTO_REVIEWER_PACKS_REQUEST_EVENT, (data) => {
      const { requestId } = data as { readonly requestId: string };
      bus.emit(
        AUTO_REVIEWER_PACKS_REGISTER_EVENT,
        registrationPayload(requestId, [
          {
            kind: "data-pack",
            pack: { version: 1, id: "pack:a", rules: [] },
          },
        ]),
      );
    });
    bus.on(AUTO_REVIEWER_PACKS_REQUEST_EVENT, (data) => {
      const { requestId } = data as { readonly requestId: string };
      bus.emit(
        AUTO_REVIEWER_PACKS_REGISTER_EVENT,
        registrationPayload(
          requestId,
          [
            {
              kind: "data-pack",
              pack: { version: 1, id: "pack:b", rules: [] },
            },
          ],
          { name: "other-pkg", installKind: "local" },
        ),
      );
    });
    const store = createPackageRegistrationStore({ events: bus });

    const snapshot = store.collect("startup");

    expect(snapshot.packs.map((p) => p.pack.id).sort()).toEqual([
      "pack:a",
      "pack:b",
    ]);
  });

  it("fires onChange exactly once per collect (not once per registration)", () => {
    const bus = createTestEventBus();
    bus.on(AUTO_REVIEWER_PACKS_REQUEST_EVENT, (data) => {
      const { requestId } = data as { readonly requestId: string };
      bus.emit(
        AUTO_REVIEWER_PACKS_REGISTER_EVENT,
        registrationPayload(requestId, [dataPackContribution()]),
      );
    });
    bus.on(AUTO_REVIEWER_PACKS_REQUEST_EVENT, (data) => {
      const { requestId } = data as { readonly requestId: string };
      bus.emit(
        AUTO_REVIEWER_PACKS_REGISTER_EVENT,
        registrationPayload(requestId, [
          { kind: "data-pack", pack: { version: 1, id: "pack:b", rules: [] } },
        ]),
      );
    });
    const onChange = vi.fn();
    const store = createPackageRegistrationStore({ events: bus, onChange });

    store.collect("startup");

    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("createPackageRegistrationStore reload clearing", () => {
  it("clears stale registrations and recollects only current responses", () => {
    const bus = createTestEventBus();
    // Contributor A responds on the first collect, then unsubscribes.
    const contributorA = (data: unknown) => {
      const { requestId } = data as { readonly requestId: string };
      bus.emit(
        AUTO_REVIEWER_PACKS_REGISTER_EVENT,
        registrationPayload(requestId, [
          { kind: "data-pack", pack: { version: 1, id: "pack:a", rules: [] } },
        ]),
      );
    };
    const contributorB = (data: unknown) => {
      const { requestId } = data as { readonly requestId: string };
      bus.emit(
        AUTO_REVIEWER_PACKS_REGISTER_EVENT,
        registrationPayload(
          requestId,
          [
            {
              kind: "data-pack",
              pack: { version: 1, id: "pack:b", rules: [] },
            },
          ],
          { name: "pkg-b", installKind: "git" },
        ),
      );
    };
    const aSubscription = bus.on(
      AUTO_REVIEWER_PACKS_REQUEST_EVENT,
      contributorA,
    );
    const store = createPackageRegistrationStore({ events: bus });

    const first = store.collect("startup");
    expect(first.packs.map((p) => p.pack.id)).toEqual(["pack:a"]);

    // Simulate a reload: A is removed, B is added.
    aSubscription?.();
    bus.on(AUTO_REVIEWER_PACKS_REQUEST_EVENT, contributorB);

    const reloaded = store.collect("reload");
    expect(reloaded.packs.map((p) => p.pack.id)).toEqual(["pack:b"]);
    expect(reloaded.packs.some((p) => p.pack.id === "pack:a")).toBe(false);
    expect(reloaded.requestId).not.toBe(first.requestId);
  });

  it("clear() drops all state and resets the request id", () => {
    const bus = createTestEventBus();
    registerContributor(bus, (requestId) =>
      registrationPayload(requestId, [dataPackContribution()]),
    );
    const store = createPackageRegistrationStore({ events: bus });

    store.collect("startup");
    expect(store.snapshot().packs).toHaveLength(1);

    store.clear();

    const snapshot = store.snapshot();
    expect(snapshot.requestId).toBeNull();
    expect(snapshot.packs).toEqual([]);
    expect(snapshot.issues).toEqual([]);
  });

  it("dispose() removes the store listener and drops state", () => {
    const bus = createTestEventBus();
    const onChange = vi.fn();
    const store = createPackageRegistrationStore({ events: bus, onChange });

    expect(bus.handlerCount(AUTO_REVIEWER_PACKS_REGISTER_EVENT)).toBe(1);

    bus.emit(
      AUTO_REVIEWER_PACKS_REGISTER_EVENT,
      registrationPayload(undefined, [dataPackContribution()]),
    );
    expect(store.snapshot().packs).toHaveLength(1);
    expect(onChange).toHaveBeenCalledTimes(1);

    store.dispose();

    expect(bus.handlerCount(AUTO_REVIEWER_PACKS_REGISTER_EVENT)).toBe(0);
    expect(store.snapshot()).toEqual({
      requestId: null,
      packs: [],
      issues: [],
    });

    bus.emit(
      AUTO_REVIEWER_PACKS_REGISTER_EVENT,
      registrationPayload(undefined, [dataPackContribution()]),
    );
    expect(store.snapshot().packs).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("rebinds cleanly on a persistent event bus when old lifetimes dispose", () => {
    const bus = createTestEventBus();
    const oldRequests: string[] = [];
    const oldContributor = bus.on(AUTO_REVIEWER_PACKS_REQUEST_EVENT, (data) => {
      const { requestId } = data as { readonly requestId: string };
      oldRequests.push(requestId);
      bus.emit(
        AUTO_REVIEWER_PACKS_REGISTER_EVENT,
        registrationPayload(requestId, [
          {
            kind: "data-pack",
            pack: { version: 1, id: "pack:old", rules: [] },
          },
        ]),
      );
    });
    const oldStore = createPackageRegistrationStore({ events: bus });
    expect(oldStore.collect("startup").packs.map((p) => p.pack.id)).toEqual([
      "pack:old",
    ]);

    oldStore.dispose();
    oldContributor();

    const newRequests: string[] = [];
    bus.on(AUTO_REVIEWER_PACKS_REQUEST_EVENT, (data) => {
      const { requestId } = data as { readonly requestId: string };
      newRequests.push(requestId);
      bus.emit(
        AUTO_REVIEWER_PACKS_REGISTER_EVENT,
        registrationPayload(
          requestId,
          [
            {
              kind: "data-pack",
              pack: { version: 1, id: "pack:new", rules: [] },
            },
          ],
          { name: "new-pkg", installKind: "npm" },
        ),
      );
    });
    const newStore = createPackageRegistrationStore({ events: bus });

    const reloaded = newStore.collect("reload");

    expect(oldRequests).toHaveLength(1);
    expect(newRequests).toHaveLength(1);
    expect(reloaded.packs.map((p) => p.pack.id)).toEqual(["pack:new"]);
    expect(reloaded.packs.some((p) => p.pack.id === "pack:old")).toBe(false);
    expect(bus.handlerCount(AUTO_REVIEWER_PACKS_REGISTER_EVENT)).toBe(1);
  });
});

describe("createPackageRegistrationStore request id handling", () => {
  it("accepts a registration echoing the current request id", () => {
    const bus = createTestEventBus();
    const store = createPackageRegistrationStore({ events: bus });
    // No contributor wired to the request; emit a matching registration by
    // hand after collecting.
    const snapshot = store.collect("startup");

    bus.emit(
      AUTO_REVIEWER_PACKS_REGISTER_EVENT,
      registrationPayload(snapshot.requestId ?? "", [dataPackContribution()]),
    );

    const after = store.snapshot();
    expect(after.packs).toHaveLength(1);
    expect(after.packs[0]?.pack.id).toBe("pack:contrib");
  });

  it("accepts an unsolicited registration with no request id, even out of band", () => {
    const bus = createTestEventBus();
    const onChange = vi.fn();
    const store = createPackageRegistrationStore({ events: bus, onChange });

    // Before any collect, an unsolicited registration (no requestId) is accepted.
    bus.emit(
      AUTO_REVIEWER_PACKS_REGISTER_EVENT,
      registrationPayload(undefined, [dataPackContribution()]),
    );

    const snapshot = store.snapshot();
    expect(snapshot.requestId).toBeNull();
    expect(snapshot.packs).toHaveLength(1);
    // Out-of-band acceptance fires onChange.
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale registration for an older request id and records a warning", () => {
    const bus = createTestEventBus();
    const store = createPackageRegistrationStore({ events: bus });

    const first = store.collect("startup");
    const staleRequestId = first.requestId ?? "";
    const second = store.collect("reload");

    // A registration echoing the OLD request id is stale after the second collect.
    bus.emit(
      AUTO_REVIEWER_PACKS_REGISTER_EVENT,
      registrationPayload(staleRequestId, [dataPackContribution()]),
    );

    const snapshot = store.snapshot();
    expect(snapshot.requestId).toBe(second.requestId);
    // Stale response contributed no packs.
    expect(snapshot.packs).toEqual([]);
    expect(snapshot.issues).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "stale-registration",
        path: "event",
      }),
    ]);
    const issue = snapshot.issues[0];
    expect(issue?.message).toContain(staleRequestId);
    expect(issue?.message).toContain(second.requestId ?? "");
  });

  it("treats a registration with a request id but no active collection as stale", () => {
    const bus = createTestEventBus();
    const store = createPackageRegistrationStore({ events: bus });

    // No collect yet; a registration carrying a request id is not unsolicited.
    bus.emit(
      AUTO_REVIEWER_PACKS_REGISTER_EVENT,
      registrationPayload("req-some-unknown-id", [dataPackContribution()]),
    );

    const snapshot = store.snapshot();
    expect(snapshot.packs).toEqual([]);
    expect(snapshot.issues).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "stale-registration",
        path: "event",
      }),
    ]);
  });
});

describe("createPackageRegistrationStore malformed payloads", () => {
  it("captures normalizer issues for a bad apiVersion and contributes no packs", () => {
    const bus = createTestEventBus();
    registerContributor(bus, (requestId) => ({
      apiVersion: 2,
      requestId,
      package: { name: "bad-pkg", installKind: "npm" },
      packs: [dataPackContribution()],
    }));
    const store = createPackageRegistrationStore({ events: bus });

    const snapshot = store.collect("startup");

    expect(snapshot.packs).toEqual([]);
    expect(snapshot.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "invalid-api-version",
        path: "$.apiVersion",
      }),
    ]);
  });

  it("captures issues for a missing package name and contributes no packs", () => {
    const bus = createTestEventBus();
    registerContributor(bus, (requestId) => ({
      apiVersion: 1,
      requestId,
      package: { installKind: "npm" },
      packs: [dataPackContribution()],
    }));
    const store = createPackageRegistrationStore({ events: bus });

    const snapshot = store.collect("startup");

    expect(snapshot.packs).toEqual([]);
    expect(snapshot.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "missing-package-name",
        path: "$.package.name",
      }),
    ]);
  });

  it("continues processing a later valid registration after a malformed one", () => {
    const bus = createTestEventBus();
    bus.on(AUTO_REVIEWER_PACKS_REQUEST_EVENT, (data) => {
      const { requestId } = data as { readonly requestId: string };
      // Emit a malformed registration and a valid one in the same collect.
      // The malformed one produces an issue; the valid one still lands.
      bus.emit(AUTO_REVIEWER_PACKS_REGISTER_EVENT, "not-an-object");
      bus.emit(
        AUTO_REVIEWER_PACKS_REGISTER_EVENT,
        registrationPayload(requestId, [dataPackContribution()]),
      );
    });
    const store = createPackageRegistrationStore({ events: bus });

    const snapshot = store.collect("startup");

    expect(snapshot.packs.map((p) => p.pack.id)).toEqual(["pack:contrib"]);
    expect(snapshot.issues).toEqual([
      expect.objectContaining({ code: "invalid-registration" }),
    ]);
  });

  it("does not throw on garbage registration payloads", () => {
    const bus = createTestEventBus();
    const garbage: unknown[] = [null, undefined, "string", 42, [], "circular"];
    let index = 0;
    bus.on(AUTO_REVIEWER_PACKS_REQUEST_EVENT, () => {
      const payload = garbage[index];
      index = (index + 1) % garbage.length;
      bus.emit(AUTO_REVIEWER_PACKS_REGISTER_EVENT, payload);
    });
    const store = createPackageRegistrationStore({ events: bus });

    expect(() => store.collect("startup")).not.toThrow();
    expect(store.snapshot().packs).toEqual([]);
  });
});

describe("createPackageRegistrationStore throwing handlers", () => {
  it("records a collection error and does not abort when a contributor request handler throws", () => {
    const bus = createTestEventBus();
    // A contributor whose request handler throws synchronously. This test bus
    // propagates the throw to emit (Pi's real bus would swallow it), so the
    // store's defensive catch turns it into an issue.
    bus.on(AUTO_REVIEWER_PACKS_REQUEST_EVENT, () => {
      throw new Error("contributor exploded");
    });
    const store = createPackageRegistrationStore({ events: bus });

    let snapshot: ReturnType<PackageRegistrationStore["collect"]> | undefined;
    expect(() => {
      snapshot = store.collect("startup");
    }).not.toThrow();

    expect(snapshot).toBeDefined();
    if (snapshot === undefined) {
      throw new Error("expected collection snapshot");
    }

    expect(snapshot.packs).toEqual([]);
    expect(snapshot.issues).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "collection-error",
        path: "event",
        message: expect.stringContaining("contributor exploded"),
      }),
    ]);
  });

  it("still captures a registration emitted by a sibling contributor when one throws", () => {
    // Faithfully model Pi's event bus: a throwing request handler is swallowed
    // per-handler, so a sibling contributor still runs and is captured. No
    // collection-error issue is produced (the bus ate the throw, not the store).
    const bus = createTestEventBus({ swallowHandlerErrors: true });
    bus.on(AUTO_REVIEWER_PACKS_REQUEST_EVENT, () => {
      throw new Error("boom");
    });
    bus.on(AUTO_REVIEWER_PACKS_REQUEST_EVENT, (data) => {
      const { requestId } = data as { readonly requestId: string };
      bus.emit(
        AUTO_REVIEWER_PACKS_REGISTER_EVENT,
        registrationPayload(requestId, [dataPackContribution()]),
      );
    });
    const store = createPackageRegistrationStore({ events: bus });

    const snapshot = store.collect("startup");

    expect(snapshot.packs.map((p) => p.pack.id)).toEqual(["pack:contrib"]);
    expect(snapshot.issues.some((i) => i.code === "collection-error")).toBe(
      false,
    );
  });
});

describe("createPackageRegistrationStore absent event bus", () => {
  it("returns an inert empty snapshot with a no-event-bus warning when events is omitted", () => {
    const store = createPackageRegistrationStore({});

    const snapshot = store.snapshot();
    expect(snapshot.requestId).toBeNull();
    expect(snapshot.packs).toEqual([]);
    expect(snapshot.issues).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "no-event-bus",
        path: "event",
      }),
    ]);
  });

  it("collect and clear are safe no-ops on the inert store", () => {
    const onChange = vi.fn();
    const store = createPackageRegistrationStore({ onChange });

    expect(() => store.collect("startup")).not.toThrow();
    expect(() => store.clear()).not.toThrow();

    const snapshot = store.snapshot();
    expect(snapshot.packs).toEqual([]);
    // Inert store never fires onChange: nothing actually changes.
    expect(onChange).not.toHaveBeenCalled();
    expect(snapshot.issues).toEqual([
      expect.objectContaining({ code: "no-event-bus" }),
    ]);
  });

  it("collect returns the same deterministic snapshot on the inert store", () => {
    const store = createPackageRegistrationStore({});

    const first = store.collect("startup");
    const second = store.collect("reload");

    expect(first).toEqual(second);
  });
});

describe("createPackageRegistrationStore deterministic snapshots", () => {
  it("snapshot is stable across reads until the next collect", () => {
    const bus = createTestEventBus();
    registerContributor(bus, (requestId) =>
      registrationPayload(requestId, [dataPackContribution()]),
    );
    const store = createPackageRegistrationStore({ events: bus });

    store.collect("startup");
    const a = store.snapshot();
    const b = store.snapshot();

    expect(a).toEqual(b);
    // Distinct array identities (defensive copies), but equal contents.
    expect(a.packs).not.toBe(b.packs);
  });

  it("mints a fresh, deterministic request id per collect", () => {
    const bus = createTestEventBus();
    const store = createPackageRegistrationStore({ events: bus });

    const first = store.collect("startup");
    const second = store.collect("reload");

    expect(first.requestId).toBe("pi-clearance:packs:request:1");
    expect(second.requestId).toBe("pi-clearance:packs:request:2");
    expect(first.requestId).not.toBe(second.requestId);
  });

  it("returns the collected snapshot from collect and reads the same from snapshot", () => {
    const bus = createTestEventBus();
    registerContributor(bus, (requestId) =>
      registrationPayload(requestId, [dataPackContribution()]),
    );
    const store = createPackageRegistrationStore({ events: bus });

    const collected = store.collect("startup");
    const reread = store.snapshot();

    expect(reread).toEqual(collected);
  });
});
