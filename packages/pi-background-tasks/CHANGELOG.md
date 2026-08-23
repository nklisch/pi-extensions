# Changelog

## v0.1.7 — 2026-08-23

### Fixed

- Contain stale session contexts, rejected wake and persistence calls, process callbacks, and monitor failures inside each job. Session replacement now cancels owned work before Pi revokes reporting access, and diagnostics remain available through job output when the session is still active.
