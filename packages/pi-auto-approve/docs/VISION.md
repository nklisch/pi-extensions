# VISION — Pi Clearance

Pi Clearance makes long-running Pi sessions feel fast without turning tool calls into a blind trust channel. Structural analyzers and deterministic rule packs handle routine work; uncertainty gets one predictable review path.

## Product shape

1. **Structural analysis** — bash and typed Pi tools become inspectable shapes; parser uncertainty reviews or denies.
2. **Broad built-in baseline** — common development, project-scoped mutation, network-read, typed research, non-secret home/support reads, and safe-home workflows are active by default while the sealed floor remains non-overridable.
3. **One behavioral dial** — `mode: off | ask | auto` globally controls only dispatch of deterministic `review` results.
4. **Model reviewer** — Auto mode resolves one uncertain call with configurable prompt/context/model details; model decisions never become policy.
5. **Pi-native Tune** — `/clearance tune` analyzes history and proposes user-approved policy or reviewer config changes.

## Mode promise

- **Off:** never asks; review-bucket calls pass through and are audited. Deterministic deny rules still block.
- **Ask:** known-safe calls run; uncertainty asks the user and blocks unattended calls.
- **Auto:** known-safe calls run; uncertainty goes model-first, then human/block fallback.

The sealed floor always wins. Invalid config fails closed to floor-only policy. Unknown (non-bash) tools default to allow through the config-file-only `unknownToolPosture` setting.

## Trust and growth

User-owned global/project config may widen policy. Repository policy and installed packs cannot silently widen it. Tune replay, adversarial checks, explicit confirmation, and post-write validation make policy growth auditable.
