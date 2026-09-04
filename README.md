# @nklisch Pi extensions

The publishing home for Nathan Klisch's Pi extensions. Every public package in this repository is an independent npm package under the `@nklisch` namespace.

## Packages

| Package | Purpose |
| --- | --- |
| [`@nklisch/pi-model-modes`](packages/pi-model-modes) | Adapts Pi's system prompt by model and mode. |
| [`@nklisch/pi-plugins`](packages/pi-plugins) | Plugin marketplace and lifecycle management for Pi. |
| [`@nklisch/pi-background-tasks`](packages/pi-background-tasks) | Background jobs, polling, status, cancellation, and wakeups. |
| [`@nklisch/pi-zai-research`](packages/pi-zai-research) | Z.ai-backed web and repository research tools. |
| [`@nklisch/pi-mcp-adapter`](packages/pi-mcp-adapter) | Maintained pi-mcp-adapter fork with a programmatic MCP source lifecycle. |
| [`@nklisch/pi-subagents`](packages/pi-subagents) | Maintained pi-subagents fork with ordered lifecycle interception (bundled by pi-plugins). |
| [`@nklisch/pi-clearance`](packages/pi-clearance) | Configurable auto-reviewer for parsed, structural command policy (tree-sitter native core). |
| [`@nklisch/pi-conveniences`](packages/pi-conveniences) | Small drop-in quality-of-life conveniences (`/exit`, `.agents/AGENTS.md` context, context-window footer, subagent model listing). |
| [`@nklisch/pi-astral-pocket`](packages/pi-astral-pocket) | Persistent note pocket and astra-session recall, active only for gpt-6-astra. |
| [`@nklisch/pi-fff-compat`](packages/pi-fff-compat) | Fast FFF-backed file search through Pi-native find/grep semantics (no fuzzy fallback). |
| [`@nklisch/pi-enhanced`](packages/pi-enhanced) | Meta package: the full harness in one install — all first-party packages plus a curated third-party set. |

Install any package with:

```sh
pi install npm:@nklisch/pi-model-modes
```

## Create an extension

```sh
npm run create:extension -- session-notes "Persistent session notes for Pi."
npm install
npm run check
```

The generator creates `packages/pi-session-notes` as `@nklisch/pi-session-notes`, with a typed entrypoint, test, Pi manifest, public publishing metadata, and repository links. `npm run validate` rejects unscoped, private, or incompletely configured workspaces, so a new extension cannot accidentally publish outside `@nklisch`.

## Develop

```sh
npm install
npm run check
```

The root check validates package policy, runs each package's type checks and tests, builds compiled packages, and inspects every npm tarball.

Test an extension directly from its workspace:

```sh
pi -e ./packages/pi-model-modes
```

## Version and publish

Packages are independently versioned:

```sh
npm version patch --workspace @nklisch/pi-model-modes --no-git-tag-version
npm run check
```

Publishing is manual through the **Publish Pi extension** GitHub Actions workflow. Enter a package directory (`pi-model-modes`), full npm name (`@nklisch/pi-model-modes`), or `all`. The workflow:

1. accepts releases only from `main`;
2. verifies the full repository;
3. skips versions already present on npm; and
4. publishes public packages through npm trusted publishing with provenance.

Configure npm trusted publishing for each package to trust `.github/workflows/publish.yml` in `nklisch/pi-extensions`. Newly generated packages need that one npm-side registration before their first release.

## Migration status

Package sources were consolidated from the sibling `pi-model-modes`, `pi-plugins`, `pi-mcp-adapter`, `pi-auto-approve` (renamed to `pi-clearance`), `skills`, and `pi-packages` (pi-subagents fork) repositories. `pi-conveniences` is the renamed successor to `@nklisch/pi-nates-toolkit`'s extension surfaces plus select personal pi-config extensions. The old repositories have not been deleted or rewritten; this repository is intended to become the npm publishing source after its GitHub repository and trusted-publisher entries are configured. Skill-only plugins (workbench, agile-workflow, and friends) intentionally remain in the `skills` repository and are adopted through `@nklisch/pi-plugins`.
