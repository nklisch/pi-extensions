*Note*: Work in progress, expect large changes or updates, breaking things and non-functional features.

# Pi Clearance

Pi Clearance is a Pi extension that structurally evaluates tool calls against a sealed deterministic policy, then dispatches only the `review` bucket through one global mode.

## Mode

```json
{ "version": 1, "mode": "ask" }
```

- **Off** — review-bucket calls pass through and are audited; floor and explicit deterministic denies still block.
- **Ask** — review-bucket calls prompt the human, with unattended block-and-log fallback.
- **Auto** — model reviewer first, then human/block fallback.

The default is `ask`. Choosing Auto through `/clearance setup`, `/clearance settings`, or `/clearance mode auto` shows the model/provider, prompt posture, context, and untrusted-context disclosure before writing global config.

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

The former profile and auto commands are removed with no aliases. Package installation only makes contributed packs available; user-owned `packEnablement.enabledPackagePacks` must explicitly enable them.

## Safety model

- Shell and typed Pi tools are analyzed structurally.
- The sealed floor is always active and cannot be loosened.
- Invalid config fails closed to floor-only policy.
- `unknownToolPosture` remains an advanced config-file-only setting and defaults to `review`.
- Model decisions resolve one call and never become policy without Tune approval.

The built-in baseline includes the former default pack set plus network reads, typed network-research tools, and safe-home typed Pi file tools. Reviewer prompt postures (`reviewer.strict`, `reviewer.default`, `reviewer.permissive`) survive as config-file-only advanced options; model pinning remains interactive in the settings UI.

See [docs/USER_GUIDE.md](docs/USER_GUIDE.md), [docs/CONFIGURATION.md](docs/CONFIGURATION.md), [docs/RULE_PACKS.md](docs/RULE_PACKS.md), [docs/PACK_AUTHORING.md](docs/PACK_AUTHORING.md), and [docs/REVIEWER_PROMPTS.md](docs/REVIEWER_PROMPTS.md).
