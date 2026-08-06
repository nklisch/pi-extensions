*Note*: Work in progress, expect large changes or updates, breaking things and non-functional features.

# Pi Clearance

Pi Clearance is a Pi extension that structurally evaluates tool calls against a sealed deterministic policy, then dispatches only the `review` bucket through one global mode.

## Mode

```json
{ "version": 1 }
```

- **Off** — review-bucket calls pass through and are audited; floor and explicit deterministic denies still block.
- **Ask** — review-bucket calls prompt the human, with unattended block-and-log fallback.
- **Auto** — model reviewer first, then human/block fallback.

The default runtime mode is `ask`; a default persisted config is only `{ "version": 1 }`. Choosing Auto through `/clearance`, `/clearance setup`, `/clearance settings`, or `/clearance mode auto` shows the model/provider, prompt posture, context, and untrusted-context disclosure before writing global config.

User-owned `global.json` and project overlays written through Clearance are sparse: they contain `version` and only choices that differ from runtime defaults. Package installation does not read, create, repair, or rewrite user config.

## Commands

```text
/clearance
/clearance setup
/clearance mode [off|ask|auto]
/clearance settings
/clearance status
/clearance packs
/clearance scope
/clearance tune
/clearance why
```

The former profile and auto commands are removed with no aliases. Package installation makes contributed packs available but does not enable them or change Clearance config; user-owned `packEnablement.enabledPackagePacks` must explicitly enable them.

## Safety model

- Shell and typed Pi tools are analyzed structurally.
- The sealed floor is always active and cannot be loosened.
- Invalid config fails closed to floor-only policy.
- Non-Bash tools bypass Clearance by default. Add exact names to global `gatedTools` to opt them into analysis and policy; Bash is always gated and cannot be listed.
- `unknownToolPosture` remains an advanced config-file-only setting and defaults to `allow`, applying only to opted-in unknown tools.
- Model decisions resolve one call and never become policy without Tune approval.

The non-Bash default bypass intentionally makes typed edit/read protections opt-in. This is a published behavioral break that must be called out in the next minor release; this package is not versioned or published by this change.

The built-in baseline includes the former default pack set plus network reads, typed network-research tools, and safe-home typed Pi file tools. Reviewer prompt postures (`reviewer.strict`, `reviewer.default`, `reviewer.permissive`) are confirm-backed settings selectors alongside reviewer model pinning; remaining advanced reviewer fields stay in user-owned config.

See [docs/USER_GUIDE.md](docs/USER_GUIDE.md), [docs/CONFIGURATION.md](docs/CONFIGURATION.md), [docs/RULE_PACKS.md](docs/RULE_PACKS.md), [docs/PACK_AUTHORING.md](docs/PACK_AUTHORING.md), and [docs/REVIEWER_PROMPTS.md](docs/REVIEWER_PROMPTS.md).
