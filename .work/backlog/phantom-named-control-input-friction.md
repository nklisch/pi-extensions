---
id: phantom-named-control-input-friction
tags: []
created: 2026-09-06
updated: 2026-09-06
---

# Phantom named Ctrl+C did not interrupt the terminal fixture

- Kind: friction
- Status: open
- Observed/proposed: 2026-09-06
- Surface: input

## Goal or use case

Qualify Orogen's waiting-question interruption in a headless 80×24 PTY. This is external Phantom feedback recorded under the environment's computer-use reporting rule; ncu was not involved and no ncu defect is asserted.

## Observation

`phantom_phantom_send` with `kind: "key", value: "ctrl-c"` reported success, but the waiting screen did not change and a 10-second wait for `interrupted` timed out. Sending the literal ETX byte with `kind: "text", value: "\u0003"` then produced canonical `settled · interrupted`. The fixture exited 0 and reported `QUESTION_JOURNEY_PASSED` after literal EOT. Input encoding or terminal key-protocol interaction remains a hypothesis, not a confirmed root cause.

## Reproduction and evidence

Session `questions-review-interrupt`, command `question_journey --interrupt`, 80×24. Initial rendered image and text both showed a waiting structured question. Named Ctrl+C left that state unchanged; literal ETX produced the interrupted screen. Evidence is in the Orogen retained correction session's MCP transcript. The completed PTY session has been terminated.

## Environment

Linux; Phantom MCP version not inspected; Orogen qualification binary SHA-256 `225c0ad16f646ad40f3eeb4f6b5a286aed03ccf0212b11f3161f8b9a1d549f7b`. Ratatui 0.30.2 and Crossterm 0.29.0. No desktop interaction; no shared-desktop interference observed or inferred.

## Workaround

Use literal ETX/EOT for these controls and verify the resulting application state and exit. Do not count the named-key tool's success as proof that the application consumed the intended input.


## Relocation context

External Phantom/terminal integration evidence, relocated here under the user's requested Pi/Krometrail split because no local Phantom repository was found. NCU was not involved; neither a Pi adapter defect nor Phantom root cause is established. This is not authorization for a Pi implementation change.
