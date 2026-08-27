---
release: subagent-result-delivery-2026-08-27
date: 2026-08-27
packages:
  - "@nklisch/pi-subagents@18.1.0-nklisch.4"
  - "@nklisch/pi-plugins@0.6.2"
  - "@nklisch/pi-enhanced@0.2.7"
items:
  - deduplicate-blocking-subagent-completion
---

# Direct subagent result delivery — 2026-08-27

A blocking `get_subagent_result` request now claims direct delivery before it waits for a background subagent. The completion-notification path observes that claim, so the parent receives the result once instead of again through a delayed follow-up.

`@nklisch/pi-plugins` and `@nklisch/pi-enhanced` rebundle the corrected subagent runtime for their consumers.

## Verification

- Focused pi-subagents tests and typecheck passed.
- The authoritative `npm run check` passed for the synchronized release candidates.
- A cross-model implementation review identified a queued-wait regression and a test-boundary gap; both were corrected before final verification.

## Publication receipts

Trusted-publishing workflow: [GitHub Actions run 33045087014](https://github.com/nklisch/pi-extensions/actions/runs/33045087014), successful from commit `524ccb4e615c7651bab9cd27f36bae18d7d59abd`.

- `@nklisch/pi-subagents@18.1.0-nklisch.4` — `sha512-T56vJdak0c6gBDsD6keVaRSJsxahadn3b5ej1uzKseGunP0qWq/7zUObZXESCfG2TtzpgrYangc5GEU/6SZIJQ==`
- `@nklisch/pi-plugins@0.6.2` — `sha512-73UBesUhlZRJZ70VnW7XZiQye3ET3U9IU6BfbMTOaYBQkVbOq5V54p4U8blDOVFo5Iuh01tJemjwQbV2LkWpZg==`
- `@nklisch/pi-enhanced@0.2.7` — `sha512-PXzDj58C7r1FrjVE2IL5sxUFZvsXKtNAW/fBL71cmA5Zd2VYxnUT9coxUzJUqTEowxzmeeBQKooler1u8U9Fyw==`
