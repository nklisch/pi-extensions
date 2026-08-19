---
source_handle: pi-playwright-skill
fetched: 2026-08-18
source_title: guwidoe/pi-playwright source repository
source_url: https://github.com/guwidoe/pi-playwright
---

The GitHub repository and README were fetched. This attestation records the package's documented architecture and feature set without independently benchmarking it.

## Attested details

1. **Skill-first integration.** `pi-playwright` is a Pi package that contributes one `playwright-browser` Agent Skill rather than registering a large set of model tools. The skill operates the local `@playwright/cli` through wrapper scripts. (`README.md`, introduction and Included skill)
2. **Browser capabilities.** The documented workflow can open pages, inspect the DOM, click, fill forms, capture screenshots, watch console and network output, and save authentication state. (`README.md`, introduction)
3. **Context posture.** The project explicitly chooses local command execution and a small skill surface to reduce model-context overhead and keep activity inspectable. (`README.md`, Why)
4. **Session isolation.** Wrapper scripts derive a browser session from the current Git repository or working directory, while allowing an explicit session override. (`README.md`, What the skill provides)
5. **Artifacts.** Screenshots, PDFs, and snapshots are written under a stable per-session temporary artifact directory. (`README.md`, Why and What the skill provides)
6. **Local dependency model.** The package uses its own Playwright CLI dependency, while the user may need to install a compatible Chromium browser once. (`README.md`, Install and What the skill provides)
7. **Developer-server convenience.** The package includes a script for probing common localhost development-server URLs. (`README.md`, What the skill provides; repository layout)
8. **Tradeoff.** Because capability is mediated through shell-invoked CLI commands and skill instructions, the model does not receive a dedicated rich browser-control UI or a native Pi browser session manager from this package. (`README.md`, architecture and usage)
9. **Fetched revision.** The fetched default branch resolved to commit `7d3eeedae9e868238af82d40ac7d2db8ff8d43e0`, whose latest commit date was 2026-03-08. The MIT-licensed package declared version `0.1.1` and test plus smoke-check scripts. (Git metadata; `package.json`)
