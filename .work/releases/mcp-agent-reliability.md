---
release: mcp-agent-reliability
status: prepared
date: 2026-09-06
packages:
  - "@nklisch/pi-mcp-adapter@2.21.0-nklisch.4"
  - "@nklisch/pi-plugins@0.8.4"
  - "@nklisch/pi-enhanced@0.4.4"
items:
  - mcp-agent-reliability
---

# MCP discovery and recovery reliability

Configured servers are visible before discovery. Searches disclose missing catalogs and recovery actions instead of presenting incomplete results as evidence that a capability is absent. Describe preserves exact input/output schemas, including references and annotations; large schemas remain recoverable. Gateway descriptions no longer churn with runtime counts or instructions.

Remote keep-alive catalogs and modern subscriptions recover within the owning runtime. Slow catalog reads retain usable tools; ambiguous tool failures are never replayed. Narrow expired-session recovery retries only if the tool still exists. Initialization retries, direct-tool publication, failure cooldowns, frozen tool restoration, and catalog expiry now retain their intended meaning across failures and shutdown.

OAuth requests owned by the adapter are bounded, stale invalidation preserves credentials replaced by another process, and manual HTTPS callbacks and optional loopback `{port}` callbacks complement fixed registered endpoints. Callback prompts and picker visibility recover after completion or cancellation. Credential chunks fit the Windows value limit. No production credential migration is required.

## Scope and compatibility

Evaluation baseline: `f20529d59261922c015c6dd3e767dc8c4ffc6ae8`, adapter `2.21.0-nklisch.3`. The coordinated consumers advance for the changed exact adapter pin and bundle. Enhanced keeps its `^0` Plugin Host range; the bundle must contain Host `0.8.4`. Subagents remains `18.2.0-nklisch.1`.

Argument-bound approvals, decoded structured results, source-qualified lifecycle/cancellation, strict programmatic transport policy, and Plugin Host's standalone `configOverlay` remain intact. No namespace tools, duplicate configuration/plugin loaders, resource-subscription registry, unrelated OAuth configuration features, or wholesale upstream merge are included.

Search remains connection-free. An explicit connect loads an omitted catalog; known cached calls still connect on demand. OAuth request deadlines do not impose a new timeout on tools or event streams. Stale credential invalidation does not serialize simultaneous successful credential writes. Exact output schemas describe decoded `structuredContent`, not the gateway envelope.

## Upstream provenance

The immutable comparison range was `08fe82be1d55036d3960c4bb3fa77ed8707f2bca` through inspected HEAD `8243eba3421e301c88c047444f34ab7d5d57163e` (146 intervening commits). The latest released upstream reference was `2.32.1`, commit `10a45367e033a32026987a75d6f401e37340c86f`, followed by 21 inspected commits. This is selective behavior intake, not a claim to integrate every change through HEAD.

Selected behavior sources, adapted to the existing local architecture:

- Discovery, schemas, and name routing: `a866754a068bd014f81bbd37bbd094808ceb085e`, `5f078744b5fd898541816317c07c584caedd94ec`, `26527c591a430a0c7568f01a0531f356092f4185`, `824b137e730cf3ac124c6924c3be2645a21a62cb`, `7d69db27f85ed141aab445fb514658beb504f81e`, `062f0ce7cf9a9522fe798b85d78a386fd26bf673`, `34f4c2c902b392a449a5b9f725664d515fc4f2d0`.
- Initialization, refresh, and publication: `4755775a6487136b1896128683ebfa0b3826b8b3`, `48799faecd9c3c81c5843f0adf268152d483f973`, `068d688f09120a2c841b87d312db25222338156c`, `c69566420c6a48de8970ab6d78601f353fdb5288`, `a3072f6494f7380cb55730ca2e6b5cc653b48672`, `3e59b8293c8cc6c712a4a4c8414729297f5ad921`, `f176ef338ed759fe268072cbdf252ece4c31cd80`, `4ce34a0f3a0f2e9538bc19c33616a8cd55a5606c`.
- TTL, catalog-only subscription repair, and diagnostics: `a3f9d7a9ccce3aa031134f8bfb657245e7dab0d1`, `34de8e344c53b36c14c6a22c2f5086b90c8abf9d`, `b2d795a064320f198ad7116f135c440ef705b14d`, `1c381eb2aaf1301cdca2dafab0ea8578af2c7d1a`, `84e3c9c6f882824f907dba365c273a6afdac20f6`, `a1535b7c22e0d542117188773c290e547a3cbe2e`, `0b76154c92e053f41a947a0c2b2f8a0b10586727`, `a02a059d0ee953c9fe01344c5204593a75977f90`.
- Credential storage, replacement, and recovery: `f772de3ebffdca955e2af17c5c56c744bda079d8`, `7e0b4fbb7426d257d653e6cdc998479c983d1672` (OAuth records only), `ada4e9893a722437e8e8b7fea117a9ae86bf9121` (optional-catalog 401 propagation, not its global credential cache), `f30c4e7af468ff59b3c83ff82055f3ed6b3da61e`, `ff234b862359e722bf4dc1c99cde62278d4b8eb3`, `6dfeaa1eff810ce822bb3a80d2f19ce49c0315f1`.
- Callback/manual input and bounded OAuth requests: `12fc920c39e2e81397b63ce5b11a1ea8ce30a97a`, `67893008ed6a922d3d78d96fcf15f448834f4744`, `02d73532be33f431d514363c9d3e145a9f61a44c`, `3e974f3b2cd3e05944330e3d89ae491c3f0a380e`, `f3192880de5e87a2ceb2cb5820e50a91eb5ebcb2`, `cb8e316f3c3fb823ed133bde2a2fa292a7d68b34`, `6ba7d360fcc67a77ccbbb4921586614798020a7a`.

MIT license and upstream attribution are preserved. Adapter LICENSE SHA-256: `2d20dfacd9742706e564470dc77438608a1e54b0ed46959f080709389209093c`.

## Review and qualification

One Astra-high design, inline owner implementation, and exactly one independent Astra-high implementation review were used, as requested. All seven reproduced review findings were accepted and corrected: subscription caller lifetime, failed host removal bookkeeping, frozen startup recovery, call-triggered reconnect failure visibility, issuer-pinned replacement credentials, TTL renewal on persistence, and invalid script search scopes. Regression tests exercise the actual SDK subscription lifetime and actual adapter factory with a faulting host. Smaller schema/auth/script guidance issues were also corrected; no second review was commissioned.

Local qualification uses Node `24.17.0` and Pi `0.82.0`. The adapter suite and 114 standalone OAuth tests pass. The root `npm run check` and packed-adapter qualification pass against the coordinated versions; the final publication gate also includes the picker-restoration correction. CI must qualify the exact source commit before publication. Windows behavior is covered by an independent 1280-code-unit store fixture, not a claim of testing a live Windows keyring.

The pre-existing Workbench validator failures remain out of scope: superseded/noncanonical `.work/archive` and a missing id in the older completed subagent-session item. Existing completed outcomes are not absorbed into this release. Unrelated Ollama work, its lock entries, and the existing structured-result release edits are excluded.

Documentation amendments preserve the existing reference structure and plain technical style for adapter users and maintainers: discovery first, exact schema inspection next, then calls and explicit recovery. The preserved contracts are connection-free search, exact schemas, narrow replay, credential ownership, and source-qualified composition.

## Publication receipts

Pending trusted workflow publication and registry-byte qualification. Dispatch only the three selected packages, never `all`. No package is declared published from local build or preparation evidence.
