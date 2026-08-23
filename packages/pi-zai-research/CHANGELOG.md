# Changelog

## v0.4.2 — 2026-08-23

### Fixed

- Always clear session-owned MCP, registry, and page-cache state during shutdown. MCP close failures remain visible but cannot retain stale resources or suppress replacement-session cleanup.
