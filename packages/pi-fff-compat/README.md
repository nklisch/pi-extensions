# @nklisch/pi-fff-compat

Exposes the fast [FFF](https://github.com/ff-labs/fff) file index through
Pi-native `find`/`grep` semantics. Upstream `@ff-labs/pi-fff` is excellent for
fuzzy/smart discovery, but its `ffind`/`ffgrep` behavior intentionally differs
from Pi's built-ins; this package provides the conservative compatibility
surface: **glob-only file lookup and exact regex/literal grep, no fuzzy
fallback** — backed by the same real-time FFF index.

```sh
pi install npm:@nklisch/pi-fff-compat
```

## Modes

| Mode | Tools | How |
| --- | --- | --- |
| Default (additive) | `fast_find`, `fast_grep` alongside the built-ins | install and go |
| Override | registers as `find`/`grep` themselves | `PI_FFF_COMPAT_OVERRIDE=1` |
| Disabled | nothing | `PI_FFF_COMPAT_DISABLE=1` |

## Commands

- `/fff-compat` — index health, indexed file count, watcher/scan status.
- `/fff-compat-rescan` — trigger a manual rescan.

## Watcher & inotify budget

FFF maintains a real-time native watcher with one watch per indexed file.
Scanning very large trees (e.g. a home directory) can exhaust
`fs.inotify.max_user_watches` and leave the index silently stale on unwatched
files. Two independent knobs:

- `PI_FFF_COMPAT_HOME_SCAN=1` — opt into home-dir scanning (default off; raise
  `fs.inotify.max_user_watches` when enabling).
- `PI_FFF_COMPAT_DISABLE_WATCH=1` — scan once, no live watcher (index goes
  stale until rescan).

The index itself, frecency, and git-aware filtering come from
[`@ff-labs/fff-node`](https://www.npmjs.com/package/@ff-labs/fff-node), loaded
as a normal dependency.
