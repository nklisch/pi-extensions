---
source_handle: pi-antigravity-package-page
fetched: 2026-08-16
source_title: pi-antigravity package page on pi.dev
source_url: https://pi.dev/packages/pi-antigravity
---

Fetched 2026-08-16. Package page (version 0.3.0 at fetch time) for the
`pi-antigravity` Pi extension.

## Attested details

1. The package describes itself as an unofficial integration, "not affiliated with or endorsed by Google", that lets Pi talk directly to Google Antigravity / Cloud Code Assist models without shelling out to an external Antigravity CLI; it requires Pi and Pi AI 0.80.0 or later.
2. Install paths: `pi install npm:pi-antigravity` or `pi install git:github.com/Rahularya01/pi-antigravity`; updates via `pi update npm:pi-antigravity`.
3. Documented behavior matches the repository: browser OAuth with PKCE, loopback callback on port 51121, automatic token refresh, model availability and quota surfaced via `/antigravity.models` and `/antigravity.usage`, and sanitized diagnostics via `/antigravity.doctor`.
4. The page warns that the auth file contains sensitive access and refresh tokens that must not be committed or shared.
