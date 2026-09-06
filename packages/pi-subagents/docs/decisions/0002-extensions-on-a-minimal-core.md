# 0002 — Workspaces and permissions are extensions on a minimal core

## Context

Worktrees are not intrinsic to what makes subagents useful. Git worktrees are one
strategy for answering “where does this child run, and what brackets the run?”
The core needs a working directory and a disposal hook; the default is the
parent's working directory with no workspace setup or teardown.

Permissions and workspaces are orthogonal concerns. They must compose as
independent extensions on the core, never knowing about each other.

## Decision

pi-subagents is a minimal orchestrator: it creates child sessions, drives their
turns, tracks results, gates concurrency, supports resume, and publishes lifecycle
boundaries. The core does not look up a named permission or workspace consumer.

### Lifecycle observation

Child-execution events expose spawning, session creation before extension binding,
completion, and disposal. A permission extension can identify the child at the
pre-bind boundary and enforce its own policy inside the child. Observation does
not replace prompts or results; those decisions use the separate ordered
interceptor contract in [ADR 0005](0005-ordered-lifecycle-interceptors.md).

### Workspace provider

A registered `WorkspaceProvider` supplies the child's working directory and
bracketed cleanup. Preparation happens when the run starts, after concurrency
admission. The session factory receives the resolved working directory, not the
provider: assembly consumes a value rather than relaying workspace policy.

The provider owns workspace-specific cleanup and result wording. With no provider,
children run in the parent's working directory. The core does not own Git worktree,
container, or sandbox implementations.

### No vacant hooks

The architecture must admit a seam without shipping it until a concrete consumer
exists. A provider with no consumer is speculative machinery, not useful
extensibility. The workspace provider and ordered lifecycle interceptors are
concrete seams; neither justifies a generic hook framework.

### Core invariants

The core removes parent-only orchestration tools from children to prevent recursive
orchestration. `src/tools/parent-tool-registry.ts` owns that set. Children otherwise
use registration-open extension tooling with the supported denylist; permission
policy remains a companion concern.

The composition test is the same with neither companion, only permissions, only
workspaces, or both: the core does not change, and the companions do not reference
each other.

## Consequences

Resource ownership stays explicit. The workspace brackets the run, the session
factory constructs a usable child session, and the subagent owns execution and
settlement. Contributors can add a workspace strategy or permission consumer
without introducing an outward dependency from the core.

[Architecture](../architecture/architecture.md) owns the overall component and
lifecycle model.
