# 0004 — Keep a narrow, substitutable operator UI

## Context

Joined runs already have their calling tool's result surface. Detached runs need
an ambient indication of progress, including several concurrent children. Reading
a child's conversation is a different task: an operator needs to inspect its
transcript without replacing the active parent session.

The goal is substitutable, not optional. A human needs some surface, but that
surface should be a consumer of the core's lifecycle and query boundaries rather
than a responsibility threaded through execution code.

## Decision

### Detached status widget

The above-editor widget represents detached agents only. Joined runs use their
inline tool surface instead of duplicating progress in the widget. The widget
maintains a bounded reactive view of active detached records and terminal linger
state; it does not require the core's spawn tools to drive rendering.

Operator status surfaces show exact effective model, effective thinking level,
active or final runtime, run id, delivery mode, and terminal reason when present.

### Native, read-only session navigation

`/subagents:sessions` lets the operator select a child transcript without leaving
the parent session. It is read-only: steering remains a separate tool behavior,
not a second editor embedded in the viewer.

Do not use `switchSession` for navigation. Switching replaces the active runtime
and conflicts with keeping the parent and its detached work running. Read and
render the transcript through supported Pi APIs instead.

The transcript has two sources and one renderer:

- A retained live child supplies messages and update subscriptions.
- After the live session is released, the retained transcript pointer supplies a
  file snapshot through Pi's session parsing and context-building APIs.

Both sources render through Pi's own message and tool-execution components, not a
parallel transcript renderer. Session release updates the source; an unavailable
snapshot preserves readable content and labels the degraded state. Candidate
identity and labels come from retained manager records rather than a directory
scan of unrelated session files. Session selection includes joined and detached
records with readable transcript sources.

### Focused settings and definition ownership

`/subagents:settings` owns operational settings. Both commands use the
`subagents:` namespace. Agent-definition creation and editing belong in ordinary
files and editors, not built-in wizards or a general `/agents` management menu.

### Distribution

The detached widget, session navigator, and settings command stay in-core as
substitutable consumers. The core's execution behavior does not depend on which UI
consumer renders it. Extracting another UI package is not required by that
boundary; reconsider distribution only when a materially different consumer or
actual coupling makes it useful.

## Consequences

The core owns run state and behavior; UI owns transient presentation and selection.
Native Pi components preserve transcript fidelity without maintaining a second
rendering system. Read-only navigation preserves parent continuity, and keeping
agent-definition editing outside the package avoids duplicating tools the operator
already has.

[Architecture](../architecture/architecture.md) owns the detailed lifecycle,
retention, observation, and transcript-query boundaries.
