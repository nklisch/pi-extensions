---
id: google-subscription-oauth-in-pi
kind: research-brief
summary: What it takes to use a Google AI subscription (Antigravity/agy OAuth) as a Pi model provider, how closely an extension can match agy's request fingerprint, and the documented account risk of doing so.
updated: 2026-08-16
source_handles:
  - agy-local-oauth-probe
  - pi-custom-provider-docs
  - pi-antigravity-repo
  - antigravity-tos
  - gemini-cli-discussion-20632
  - google-apis-tos
  - pi-antigravity-package-page
relationships:
  - type: informs
    target: .research/briefs/antigravity-plugin-support.md
---

# Google subscription OAuth in Pi (agy-fingerprinted)

## Decision boundary

Question: what would it take to drive Pi from the Google AI subscription behind
the local Antigravity CLI (`agy`) OAuth login, mimicking agy's request
fingerprint, and does the subscription actually permit this? Scope: mechanism,
existing implementations, fingerprint fidelity, and policy risk. Not in scope:
building the extension, evading Google's abuse detection beyond fingerprint
parity.

## Findings

### The mechanism is fully supported by Pi and already exists as an extension

Pi's extension API supports everything needed: custom providers with OAuth
login integrated into `/login`, automatic token refresh persisted to
`~/.pi/agent/auth.json`, and a `streamSimple` hook for non-standard streaming
APIs [pi-custom-provider-docs]{1}, [pi-custom-provider-docs]{2},
[pi-custom-provider-docs]{3}.

The community extension `pi-antigravity` (npm, MIT) already implements exactly
this: PKCE OAuth login via `/login antigravity`, direct streaming against
`https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`,
project discovery via `loadCodeAssist` / `listCloudAICompanionProjects`, live
model/quota introspection commands, and a diagnostics command
[pi-antigravity-repo]{1}, [pi-antigravity-repo]{2},
[pi-antigravity-package-page]{1}, [pi-antigravity-package-page]{3}.

### The OAuth identity layer is already identical to agy's

Direct verification on this machine: the live agy consumer token's audience is
the same Google OAuth client ID that `pi-antigravity` embeds
(`1071006060591-...`; agy's binary also embeds it alongside a second client ID),
and the granted scopes are the same set pi-antigravity requests (`aicode`,
`cloud-platform`, `cclog`, `userinfo.email`, `userinfo.profile`,
`experimentsandconfigs`) [agy-local-oauth-probe]{1}, [agy-local-oauth-probe]{5},
[pi-antigravity-repo]{1}. agy stores its token as standard OAuth2 JSON in the
freedesktop Secret Service (`service=gemini`, `username=antigravity`), so an
extension could either run its own `/login` or import agy's existing
refresh-token credential [agy-local-oauth-probe]{4}.

The subscription token verifiably works against the model API from a plain
script: a single `fetchAvailableModels` call with the agy token returned the
account's 24-model catalog (Gemini 3.x family, Claude Sonnet/Opus 4.6, GPT-OSS
120B) with per-model quota fractions [agy-local-oauth-probe]{6}.

### Fingerprint parity is achievable and mostly implemented

pi-antigravity's headers and envelope are modeled on Antigravity: User-Agent
`antigravity/<ver> <os>/<arch>` (env-overridable), `X-Goog-Api-Client:
google-cloud-sdk vscode_cloudshelleditor/0.1`, `Client-Metadata` JSON with
`ideType: ANTIGRAVITY` / `pluginType: GEMINI`, and a request envelope carrying
`project`, `model`, `requestType: agent`, `userAgent: "antigravity"`, and
`requestId` [pi-antigravity-repo]{3}, [pi-antigravity-repo]{4}.

Residual fingerprint gaps (inference from comparing the two implementations):
pi-antigravity's hardcoded UA version (`1.15.8`) tracks the Antigravity IDE,
not the installed agy CLI (`1.1.13`), so the two agents on this machine would
present different versions; the agy binary also wires telemetry (`cclog`),
experiment flags (`experimentsandconfig`), and gRPC sidecar services that a
thin HTTP client does not reproduce. Whether Google's abuse pipeline scores any
of those signals is unknown — no source attests to the detection criteria.

### Policy reality: the subscription does not permit this, and fingerprinting does not change that

The Antigravity Additional Terms state that "using the Service in connection
with products not provided by us" and "using third party software, tools, or
services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is
a breach of this Agreement," grounds for suspension or termination
[antigravity-tos]{1}. Google's Gemini CLI team confirmed a February 2026 ban
wave targeting exactly this pattern, noted that bans at the shared abuse
backend also cut off Gemini CLI and Code Assist, and stated that a second
violation results in a permanent ban [gemini-cli-discussion-20632]{1},
[gemini-cli-discussion-20632]{4}. The general Google APIs ToS separately
prohibits masking the API client's identity [google-apis-tos]{1} — a clause in
direct tension with explicit fingerprint spoofing — and prohibits embedding
developer credentials in open-source projects [google-apis-tos]{3}, which the
public-client ecosystem (agy, gemini-cli, pi-antigravity) all do by necessity.

So: "looking as close to agy as possible" reduces detectability only if
detection is fingerprint-based; it does not make the use permitted, and the
penalty escalates to permanent account-level bans affecting Gemini CLI and Code
Assist as well [gemini-cli-discussion-20632]{2},
[gemini-cli-discussion-20632]{4}.

## Disconfirming evidence

- Searched for evidence that Google tolerates or ignores thin third-party
  clients: none found. The only official statement located
  [gemini-cli-discussion-20632] is explicitly prohibitive and describes active
  enforcement with a permanent-ban second strike.
- Evidence that fingerprint parity defeats enforcement is absent: the February
  2026 wave caught tools (OpenClaw, OpenCode, proxies) several of which
  presented as official clients, and Google has never published detection
  criteria. The ban reports are anecdotal aggregates in a web-search synthesis;
  the underlying Reddit/forum threads could not be individually fetched
  (extraction failures), so per-tool ban rates are unattested.
- Tension, not contradiction: pi-antigravity remains published and functional
  (the live catalog call succeeded on this account), i.e. enforcement is
  neither universal nor continuous. "It works today" and "it is permitted" are
  independent claims; only the first is verified here.
- The Gemini API Additional Terms page (ai.google.dev/gemini-api/terms) could
  not be fetched (auth redirect loop); statements about Gemini-API-specific
  terms rely on the general Google APIs ToS instead.

## Confidence limits

- High confidence: mechanism, extension existence, OAuth/scope/header parity,
  live token validity — all directly verified on this machine or read from
  pinned source.
- High confidence: third-party OAuth access violates the Antigravity ToS and
  has triggered account bans — attested from Google's own terms and an official
  team statement.
- Low confidence: how much fingerprint fidelity changes practical detection
  risk; no attested evidence exists either way.
