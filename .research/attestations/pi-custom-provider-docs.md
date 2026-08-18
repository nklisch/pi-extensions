---
source_handle: pi-custom-provider-docs
fetched: 2026-08-16
source_title: Pi custom provider documentation (installed @earendil-works/pi-coding-agent docs/custom-provider.md)
source_url: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/custom-provider.md
---

Read from the locally installed Pi package
(`/home/nathan/.local/share/mise/installs/node/24.17.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/custom-provider.md`);
the same document is published in the pi-mono repository at the URL above.

## Attested details

1. Extensions register model providers with `pi.registerProvider()`, either as a complete pi-ai `Provider` via `createProvider({...})` or as a legacy provider-config form `pi.registerProvider("id", { baseUrl, apiKey, api, models, headers, oauth, streamSimple, ... })`. `pi.unregisterProvider(name)` removes registrations and restores overridden built-ins.
2. Built-in API types usable for streaming include `google-generative-ai` and `google-vertex`; a fully custom API is supported by supplying `streamSimple(model, context, options)`, which returns an `AssistantMessageEventStream` driven by `stream.push()` events (`start`, `text_*`, `thinking_*`, `toolcall_*`, `done`/`error`).
3. OAuth support integrates with `/login <provider>`: the config's `oauth` object provides `login(callbacks)`, `refreshToken(credentials, signal)`, and `getApiKey(credentials)`. Callbacks include `onAuth({url})`, `onDeviceCode(...)`, `onProgress`, `onPrompt`, and `onSelect`. Credentials `{refresh, access, expires}` are persisted in `~/.pi/agent/auth.json`.
4. The extension factory may be `async`; Pi waits for it before startup, so a provider can fetch a remote model list and register it before interactive startup or `pi --list-models`.
5. Config values for `apiKey` and header values support `$ENV_VAR` interpolation and `!command` execution; `authHeader: true` adds `Authorization: Bearer <resolved key>` to each request, and an explicit request `Authorization` header takes precedence.
6. Context-overflow auto-recovery requires the provider error message to match known patterns; the docs recommend a `message_end` handler that rewrites provider-specific overflow errors to start with `context_length_exceeded`, scoped to the custom provider.
