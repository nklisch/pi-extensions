# VISION — @nklisch/pi-mcp-adapter

`@nklisch/pi-mcp-adapter` is an independently maintained, MIT-licensed MCP client for Pi. It descends from [`nicobailon/pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) and retains that attribution, but it has its own product direction, releases, support policy, and compatibility commitments.

The package provides the complete MCP client layer: standard-I/O and HTTP transports, authentication, elicitation, sampling, discovery, prompts, output handling, and MCP Apps. It also provides a programmatic configuration-source lifecycle for extensions that need to register and replace MCP servers without writing files or owning transport code.

## Product shape

- The root extension and CLI provide standalone MCP operation, configuration discovery, direct tools, management, authentication, and MCP Apps.
- The `./programmatic` export provides source-qualified registration, inspection, replacement, removal, launch values, cancellation, and runtime leases.
- Programmatic servers are identified by their exact source revision. Display names never determine process, tool, cache, status, or cleanup ownership.
- Agent discovery stays compact. The model receives a bounded inventory of known tool names, loads exact schemas on demand, and receives schema guidance after tool validation failures.
- `pi-plugins` consumes the exact sibling package through the standalone factory's `configOverlay` option. Plugin declarations augment normal file discovery. Release qualification covers this composition and the separate `./programmatic` export.

## Design priorities

### Complete MCP behavior

The adapter owns one transport, authentication, discovery, lifecycle, and MCP Apps implementation shared by standalone and programmatic operation. New protocol behavior is integrated at that common boundary instead of creating a second client stack.

### Honest, bounded agent context

Status and cached inventories never pretend an unconnected server has been enumerated. Search, schema loading, calls, and errors expose enough exact information for reliable tool use without placing every tool schema permanently in model context.

### Exact runtime ownership

A programmatic source can change while Pi remains running. Replacement and removal therefore close source-owned executions, connections, caches, providers, and leases before publishing the new state. Failure leaves the previous exact source usable.

### Independent maintenance

Other implementations are useful prior art and compatibility evidence. Their changes are evaluated and may be integrated, rewritten, or rejected. No external repository or package controls this package's version, release cadence, runtime availability, or retirement.

## Boundaries

The adapter owns generic MCP behavior. It does not own Plugin Host installation policy, marketplace state, trust decisions, plugin revisions, or generated runtime projections.

The programmatic boundary does not accept process-global secret injection or durable expanded launch values. Launch values are resolved immediately before a connection and disposed immediately afterward. Capability reporting must match behavior; standalone features remain unavailable programmatically until source identity, cancellation, cleanup, and lease semantics are preserved.

Published configuration paths, extension tools, commands, package exports, and programmatic contracts change deliberately and are communicated through versioned releases. Internal project-owned shapes change in place when no external consumer or durable user data requires compatibility.
