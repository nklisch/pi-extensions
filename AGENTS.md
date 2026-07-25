# Pi Extensions Monorepo

All publishable workspaces live under `packages/pi-*` and must publish as `@nklisch/pi-*`. Use `npm run create:extension -- <name> [description]` for new packages rather than hand-copying an existing package.

Run `npm run check` after changing package source, metadata, tests, build configuration, or publishing infrastructure. Keep packages independently versioned and do not publish the private root workspace.
