---
release: extension-error-containment-2026-08-23
date: 2026-08-23
packages:
  - "@nklisch/pi-background-tasks@0.1.7"
  - "@nklisch/pi-clearance@0.2.5"
  - "@nklisch/pi-conveniences@0.1.2"
  - "@nklisch/pi-enhanced@0.2.1"
  - "@nklisch/pi-fff-compat@0.1.2"
  - "@nklisch/pi-legible@0.1.1"
  - "@nklisch/pi-mcp-adapter@2.21.0-nklisch.1"
  - "@nklisch/pi-model-modes@0.3.4"
  - "@nklisch/pi-plugins@0.4.1"
  - "@nklisch/pi-subagents@18.1.0-nklisch.2"
  - "@nklisch/pi-zai-research@0.4.2"
items:
  - feature-extension-error-containment
---

# Extension error containment — 2026-08-23

All publishable extensions now keep extension-owned timer, process, raw callback, detached promise, reporting, and cleanup failures inside the extension boundary. Pi-owned awaited tool, command, and lifecycle failures retain their normal host error behavior.

## Runtime outcomes

- Background Tasks no longer retains stale session contexts in delayed process and monitor work. Persistence, wake, UI, diagnostic, and shutdown fan-out failures settle as observable job state without terminating Pi.
- Clearance contains raw package-registration and command-transform listeners, native settings callbacks and finalizers, temporary-file cleanup, transcript rendering, and shutdown fan-out while preserving policy decisions.
- MCP Adapter contains Unix-socket and metadata callbacks, Apps watchdogs and completion chains, OAuth callback requests, worker termination, delayed status, and secondary tool-failure cleanup.
- Plugin Host contains update startup, process completion, subagent disposal, manager timers and install cleanup, hook presentation, and failing diagnostic sinks.
- Subagents isolates lifecycle, observer, transcript, widget, timer, workspace, child-session, and cleanup sinks while keeping background records terminal and public contracts unchanged.
- Conveniences, Model Modes, FFF compatibility, Legible, and Z.ai Research contain stale presentation, rejected message, async finder, rewrite-status, and session-cleanup paths.
- Pi Enhanced rebundles the synchronized package set used by the installation path that reproduced the original stale-context crash.

## Compatibility

No intentional breaking public API changes were introduced. Tool failures remain agent-visible host errors when Pi owns the awaited call. Exact maintained-fork pins are synchronized for Plugin Host and Pi Enhanced.

## Verification

- Authoritative `npm run check` passed after review fixes and packed all eleven release candidates.
- Background Tasks: 38 tests; Clearance focused and repository suites; Conveniences: 17 tests; MCP Adapter: 1,006 Vitest and 114 OAuth/callback tests; Plugin Host: 1,538 tests plus focused review regressions; Subagents: 995 tests plus typecheck, declaration build, and packed-consumer public types; Model Modes: 476 tests; FFF compatibility: 8 tests; Legible: 48 tests; Z.ai Research: 137 tests.
- Fresh-context GLM 5.3 reviews found no high- or medium-severity defects. Four low-severity observability and boundary-test findings were fixed and requalified.
- Workbench and knowledge-index validation passed with zero warnings.
- The CI-only Git identity replacement regression passed ten consecutive local runs before the successful publication retry.

## Publication receipts

Trusted-publishing workflow: [GitHub Actions run 32653381344](https://github.com/nklisch/pi-extensions/actions/runs/32653381344), successful on 2026-08-23.

Registry verification returned each exact version with a SHA-512 integrity receipt:

- `@nklisch/pi-background-tasks@0.1.7` — `sha512-ULAlK7DZnPjy/Dt6nzEYIhnZroPKKY565ZSE4Zw15M94ub3LjsHceL9QEjtQ3pb1VMJzE4dUM9MNAea2CE868A==`
- `@nklisch/pi-clearance@0.2.5` — `sha512-irXiyFWtiTEzTxSkNCd0ZLi/piyun+jM7tUfBTULjiZC92nWhlMsv34IyRY1WyYY9tSNhBgREsQiBsJDOpzdgw==`
- `@nklisch/pi-conveniences@0.1.2` — `sha512-BoAZY4RU1iMrnpdV+ECDJ6uwj0iJxQhgCVTdWeMJ8o908e06RNcHaa4MaXJssO2EGwzU2PZcsFkImeRNLnjTIg==`
- `@nklisch/pi-enhanced@0.2.1` — `sha512-5OED4brLcPXrGLg2kALrk4fCA8byEw1fPiT0B815NEKgTskA0HB5NOCbJIWcY99f76OTTt9fT34NN4bCtPhvFg==`
- `@nklisch/pi-fff-compat@0.1.2` — `sha512-Q6pB87kjR8ME9ZI8V2JeBBe9oLL6TFl/8vDCjSdjO4IT/gxWUGQq862faJPTP0C5OkunohcGz1mfex7TExV0YA==`
- `@nklisch/pi-legible@0.1.1` — `sha512-Z6hWwBLnJdjOPNgnDTObkMgcPInNOSLjbdBQz4Lun/VVsUQbdcoQYerAgbUP0WylyLzr1fb3C8lf/fuYSmbvwQ==`
- `@nklisch/pi-mcp-adapter@2.21.0-nklisch.1` — `sha512-Ej33nMNh0c8l4t6rnrzUzSe7A6e9PeLyXU9aqS/IH3BOKStI7CnPXJVncBrSWASXPN2rOGWlEBcK9R/W5Al9bQ==`
- `@nklisch/pi-model-modes@0.3.4` — `sha512-oeejW+wtex0UUMuprIY/yHxXFtIvPh6WxPtse6lQFNZUsci2kad2LJkmWqJUXKzv9SeqQHGT57WyarNPXSqtpA==`
- `@nklisch/pi-plugins@0.4.1` — `sha512-HAw+ciDYIKmGTTqTIeDhkrK6dTJPli2hYjWlXPdKE4fj+QOff5iQdzjyK5xtXAH51RXUDN4Lex5xc5Fr3nWucg==`
- `@nklisch/pi-subagents@18.1.0-nklisch.2` — `sha512-nu5PFpR1eCRiiDWiWxq9HXU/rgBxkyxb+bcHgNw3RYwzRUzbTXAnumW/B12DS3AHgaiGonJm9Vcxzmiyg9CRvA==`
- `@nklisch/pi-zai-research@0.4.2` — `sha512-fxRbr27h1yb7aVLKCbZ9A/s3yXCDRUwatn3X5zvM/NWAyjU6eYoOXxeypdIQ4Ex8eoLy36ENLpc9U/xbVhCt3g==`
