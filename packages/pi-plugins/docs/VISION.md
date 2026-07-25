# Pi Plugin Host

## Purpose

Pi Plugin Host makes Claude Code and OpenAI Codex plugin marketplaces usable
directly from Pi. A plugin author publishes one marketplace and one plugin
bundle; a Pi user installs that bundle without requiring a separate Pi package
or host-specific compatibility extension.

Claude Code and Codex do not need to be installed. Pi Plugin Host independently
reads their public marketplace and plugin formats, acquires plugin sources, and
runs the shared compatibility surface through Pi.

## Problem

Agent Skills are portable, but plugin installation is not. A useful plugin often
combines skills with lifecycle hooks and MCP servers. Pi can run each capability,
but it does not treat a foreign plugin as one installable, updateable unit.

This forces plugin authors to maintain Pi-specific manifests and extensions. It
also forces users to reproduce hook and MCP configuration manually. The result
is duplicated packaging, inconsistent updates, and plugins that behave
differently across hosts.

## Users

### Pi users

Pi users add a marketplace, inspect its plugins, and install a complete
compatible plugin. Installation, enablement, updates, and removal apply to the
plugin as a unit across user and project scopes.

### Plugin authors

Plugin authors publish standard Claude Code or Codex marketplace metadata.
Compatible skills, command hooks, and MCP servers work in Pi without a separate
Pi distribution channel.

### Project teams

Teams declare project-scoped plugins using portable source specifications.
Collaborators synchronize those declarations after trusting the project,
without committing machine-specific paths, caches, or trust decisions.

## Product promise

A compatible foreign plugin behaves as a native Pi installation:

- The marketplace is browsable and updateable.
- The plugin installs all supported components together.
- Skills are discoverable by Pi.
- Command hooks receive compatible events, inputs, outputs, and plugin paths.
- MCP servers participate in Pi's MCP runtime.
- Enable, disable, update, and uninstall operations affect the whole bundle.
- Failed operations preserve the current working revision.
- Unsupported behavior is reported before activation rather than silently
  omitted.
- Neither Claude Code nor Codex is a runtime dependency.

## Compatibility boundary

The shared supported component surface is:

1. Agent Skills
2. Command lifecycle hooks
3. MCP servers

Compatibility includes the marketplace, source-resolution, scope, state,
trust, and update behavior required to install those components coherently.

Host-specific runtime components outside this shared surface are not emulated.
These include Claude agents, Codex apps and connectors, LSP servers, monitors,
themes, output styles, and enterprise management policy.

A plugin that depends on unsupported runtime behavior is identified as
incompatible. Metadata that does not affect runtime behavior may be retained or
ignored without changing the compatibility verdict.

## Principles

### Standalone operation

Pi owns its plugin state and runtime behavior. Foreign host installations are
optional discovery sources, never operational dependencies.

### Whole-plugin lifecycle

A plugin is the unit of installation. Components are not independently selected,
updated, or removed.

### Honest compatibility

The host distinguishes faithful support, harmless metadata differences, and
incompatible semantics. Approximation is never presented as equivalence.

### Atomic change

Installation and updates stage and validate the complete bundle before changing
the active revision. A failed transition leaves the previous revision usable.

### Explicit trust

Skills, hooks, and MCP servers can cause code execution. Pi presents executable
surfaces before activation and binds trust to identifiable plugin sources and
component definitions.

### Native Pi experience

Marketplace browsing and plugin management use Pi's commands, interaction
patterns, project trust, resource discovery, and reload lifecycle.

## Success

The project succeeds when an unchanged compatible plugin from a Git-backed
Claude Code or Codex marketplace can be installed into a clean Pi environment,
used through all three supported component types, updated from its authoritative
source, and removed without residual runtime configuration.

It also succeeds when incompatibility is predictable: users and plugin authors
receive a precise explanation of which construct cannot run and why.

## Anti-vision

The project fails if:

- plugin authors still need Pi-specific packaging for the supported surface;
- users manually duplicate hook or MCP configuration;
- updates drift from the authoritative marketplace;
- foreign host installations become hidden runtime dependencies;
- unsupported components disappear silently;
- approximate hook behavior is described as compatible;
- installation or update failure damages a working plugin;
- convenience bypasses meaningful trust boundaries.
