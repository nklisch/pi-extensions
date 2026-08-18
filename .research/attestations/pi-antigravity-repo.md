---
source_handle: pi-antigravity-repo
fetched: 2026-08-16
source_title: Rahularya01/pi-antigravity source at commit f7802251
source_url: https://github.com/Rahularya01/pi-antigravity/tree/f7802251e91416a3cf016e64bde94043a8a389d4
---

Cloned and read on 2026-08-16. `pi-antigravity` is a Pi extension (npm package
`pi-antigravity`, MIT) that registers an `antigravity` provider talking
directly to Google's Cloud Code Assist / Antigravity backend.

## Attested details

1. OAuth (`src/auth/oauth.ts`): Authorization Code flow with PKCE against `https://accounts.google.com/o/oauth2/v2/auth`, token exchange at `https://oauth2.googleapis.com/token`, loopback callback at `http://localhost:51121/oauth-callback`. The embedded default client ID decodes to `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com` with a base64-embedded client secret constant; the source comment describes it as "Google's public Antigravity desktop client". Requested scopes: `aicode`, `cloud-platform`, `userinfo.email`, `userinfo.profile`, `cclog`, `experimentsandconfigs`.
2. Endpoints (`src/client/client.ts`): default `https://cloudcode-pa.googleapis.com` with fallback `https://daily-cloudcode-pa.sandbox.googleapis.com`. Discovery calls: `POST /v1internal:listCloudAICompanionProjects`, `/v1internal:fetchAvailableModels`, `/v1internal:loadCodeAssist` (body includes `metadata: {ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI"}`). Streaming: `POST /v1internal:streamGenerateContent?alt=sse` (`src/stream/stream.ts`).
3. Request fingerprint (`src/client/client.ts` `antigravityHeaders`): `Authorization: Bearer`, `Content-Type: application/json`, `Accept: text/event-stream`, `User-Agent: antigravity/1.15.8 <os>/<arch>` (overridable via `ANTIGRAVITY_USER_AGENT`), `X-Goog-Api-Client: google-cloud-sdk vscode_cloudshelleditor/0.1`, and `Client-Metadata: {"ideType":"ANTIGRAVITY","platform":<Platform enum>,"pluginType":"GEMINI"}`.
4. Request envelope (`src/stream/stream.ts`): top-level `{project, model, request, requestType: "agent" (AntigravityRequestType.Agent), userAgent: "antigravity", requestId}` with optional `sessionId`; Claude models get `toolConfig.functionCallingConfig.mode` defaulting to a "validated" mode.
5. Model routing: seven public model IDs (`gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.1-pro`, `claude-sonnet-4-6`, `claude-opus-4-6`, `gpt-oss-120b`) map to effort-specific runtime IDs; a comment documents verified backend behavior that `fetchAvailableModels` with `{}` or `{project}` returns byte-identical catalogs and `cloudaicompanionProject` is rejected with HTTP 400 "Unknown name".
6. Configuration env vars: `ANTIGRAVITY_BASE_URL` (validated to HTTPS, no URL credentials, allowed Google APIs host), `ANTIGRAVITY_PROJECT_ID`, `ANTIGRAVITY_CALLBACK_HOST` (loopback only), `ANTIGRAVITY_USER_AGENT`, `ANTIGRAVITY_RUNTIME_MODEL`, `ANTIGRAVITY_CLIENT_ID`, `ANTIGRAVITY_CLIENT_SECRET`.
7. The README documents `/login antigravity`, `/antigravity.usage`, `/antigravity.models`, and `/antigravity.doctor` commands; credentials are stored in Pi's auth store (`~/.pi/agent/auth.json`) with an extended payload including `projectId` and `email`.
