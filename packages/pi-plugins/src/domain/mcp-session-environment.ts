/**
 * Desktop session variables passed through to every standard-I/O MCP server
 * when present in the captured host environment.
 *
 * Why: a stdio server is a local child process and may itself spawn GUI
 * children (browser automation, screenshot capture, desktop tooling). Those
 * children need the session pointers — display, Wayland socket, X authority,
 * D-Bus session bus, runtime dir — or they exit at startup (observed: Chrome
 * aborts with "Missing X server or $DISPLAY"). The MCP SDK already inherits a
 * sudo-inspired safe list (HOME, PATH, ...) for exactly this reason; this list
 * extends the same idea to desktop sessions.
 *
 * Custody posture is unchanged: these names carry addresses, not credentials.
 * Secret material still reaches a server only through explicit template
 * declarations. Deliberately excluded: SSH_AUTH_SOCK and other agent sockets
 * (signing authority), XDG_SESSION_* (not needed by GUI children), and any
 * credential-bearing variable. Explicit template env declarations take
 * precedence over passthrough values for the same name.
 *
 * The list must stay sorted: the launch environment port requires requested
 * names to be unique and sorted, and these names join that request.
 */
export const MCP_STDIO_SESSION_ENVIRONMENT_NAMES: readonly string[] = Object.freeze([
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
]);
