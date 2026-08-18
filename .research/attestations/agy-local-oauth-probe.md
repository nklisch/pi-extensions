---
source_handle: agy-local-oauth-probe
fetched: 2026-08-16
source_title: Direct probes of locally installed Antigravity CLI 1.1.13 auth state and Cloud Code endpoints
---

This attestation records read-only probes run on the engagement machine on
2026-08-16: inspection of the installed `agy` 1.1.13 binary strings, the
freedesktop Secret Service keyring entry agy writes at login, Google's public
`tokeninfo` endpoint for the stored access token, and a single read-only
`fetchAvailableModels` call against `cloudcode-pa.googleapis.com` using the
user's own token. There is no public URL for this material; the access surface
is the local machine plus Google's public endpoints. No token values,
credentials, or account identifiers are recorded here.

## Attested details

1. The installed `agy` binary (ELF, Go, 196.6 MB, `~/.local/bin/agy`) reports version 1.1.13 and embeds two Google OAuth client IDs: `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com` and `884354919052-36trc1jjb3tguiac32ov6cod268c5blh.apps.googleusercontent.com`, plus two embedded OAuth client-secret constants (not recorded here), the token endpoint `https://oauth2.googleapis.com/token`, and the authorization endpoints `https://accounts.google.com/o/oauth2/auth` and `https://auth.cloud.google/authorize`.
2. The binary references the API hosts `https://cloudcode-pa.googleapis.com`, `https://daily-cloudcode-pa.googleapis.com`, and `businessaicode.googleapis.com/locations.generateContent`, `fetchQuotaStatus`, `selfAssignLicense`, and `sendTelemetry`, and the internal proto packages `google.internal.cloud.code.v1internal` (CloudCode, PredictionService, JetskiService) with methods including `LoadCodeAssist`, `FetchAvailableModels`, `RetrieveUserQuotaSummary`, and `OnboardUser`.
3. The binary contains the OAuth scopes `https://www.googleapis.com/auth/aicode`, `.../cclog`, `.../cloud-platform`, `.../userinfo.email`, `.../userinfo.profile`, `.../experimentsandconfig`, and several `drive.*` scopes, plus log messages "Failed to persist token to keyring", "Keyring SaveUserTier timed out after %v, falling back to file storage", "Successfully authenticated. Quota project set to: %q", and "Using file-based token storage because %s detected".
4. agy stores its OAuth token in the freedesktop Secret Service (served by KDE `ksecretd` on this machine) as an item with attributes `service=gemini`, `username=antigravity`, label `Password for 'antigravity' on 'gemini'`. The secret value is a JSON object `{"token": {"access_token", "token_type": "Bearer", "refresh_token", "expiry"}, "auth_method": "consumer"}`. No token file was found under `~/.gemini`.
5. Google's `https://oauth2.googleapis.com/tokeninfo` endpoint reported for the stored access token these values: `aud` and `azp` equal to the client ID `1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com`, `access_type: offline`, and scopes `email profile openid` plus `aicode`, `cclog`, `cloud-platform`, `experimentsandconfigs` (plural), `userinfo.email`, and `userinfo.profile`. The token had roughly one hour of validity remaining at probe time.
6. A single POST to `https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels` with an empty JSON body, the stored access token, and Antigravity-style headers (`User-Agent: antigravity/1.1.13 linux/amd64`, `X-Goog-Api-Client: google-cloud-sdk vscode_cloudshelleditor/0.1`, `Client-Metadata` JSON with `ideType: ANTIGRAVITY`, `pluginType: GEMINI`) returned HTTP 200 with a catalog of 24 runtime models for the account, including `gemini-3.6-flash-high/medium/low`, `gemini-3.6-flash-tiered`, `gemini-3-flash`, `gemini-3-flash-agent`, `gemini-3.1-pro-high/low`, `gemini-pro-agent`, `gemini-3.5-flash-low/extra-low`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`, and image/lite/tab variants, each with `quotaInfo.remainingFraction` and most with `resetTime`.
