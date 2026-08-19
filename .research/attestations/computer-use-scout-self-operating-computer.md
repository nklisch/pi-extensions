---
source_handle: computer-use-scout-self-operating-computer
fetched: 2026-08-18
source_title: OthersideAI/self-operating-computer repository at commit fac568e
source_url: https://github.com/OthersideAI/self-operating-computer/tree/fac568eea7da5e24f8bc91bfc1211b65679177eb
---

The upstream Git repository was cloned in full and the README, `operate/` package source, and requirements at HEAD commit `fac568eea7da5e24f8bc91bfc1211b65679177eb` (last commit 2025-09-19) were inspected. This attestation describes only what that source states or implements.

## Attested details

1. **Full-desktop scope via human I/O.** "A framework to enable multimodal models to operate a computer. Using the same inputs and outputs as a human operator, the model views the screen and decides on a series of mouse and keyboard actions to reach an objective." Released November 2023 as "one of the first examples of full computer-use." Compatible with macOS, Windows, and Linux (with X server). (`README.md`, header and Compatibility)
2. **Screenshot-plus-coordinate interaction.** The loop captures the screen (`operate/utils/screenshot.py`) and issues mouse/keyboard actions (`operate/utils/operating_system.py`). Two grounding aids are offered: OCR mode (`gpt-4-with-ocr`, default, giving the model "a hash map of clickable elements by coordinates") and Set-of-Mark prompting with a bundled YOLOv8 button-detection model (`operate/models/weights/best.pt`). (`README.md`, OCR and SoM sections; `operate/` layout)
3. **Model coupling.** Integrated models are GPT-4o (default), GPT-4.1, o1, Gemini Pro Vision, Claude 3, Qwen-VL, and LLaVa via Ollama for local inference. The README warns LLaVa error rates are "very high" and that gpt-4o requires an OpenAI account with at least $5 in API credits. All non-Ollama models are hosted API calls. (`README.md`, Key Features, model sections, Rate Limiting Note)
4. **Integration surface: CLI only.** The framework is a pip package (`pip install self-operating-computer`) run as the interactive `operate` command, with flags for model selection (`-m`), voice input (`--voice`), and `--verbose`. There is no MCP server, no SDK-style embedding API documented, and no agent-skill packaging; actions execute directly on the operator's own screen. (`README.md`; `operate/main.py`)
5. **Permission model.** Requires the operator to grant the terminal "Screen Recording" and "Accessibility" permissions (macOS System Preferences) and then operates the real user session with the user's own privileges; no sandbox, isolation, approval gate, or allowlist mechanism appears in the source. (`README.md`, step 4; `operate/`)
6. **Observability.** A `--verbose` flag exists in `operate/main.py`; operation is visible by definition because the agent moves the real cursor on the operator's display. No structured logging, tracing, or recording subsystem is present. (`operate/main.py`; `README.md`)
7. **Maintenance state.** The most recent commit is dated 2025-09-19; the README still references GPT-4o/GPT-4.1/o1/Claude 3-era models and contains a commented-out gpt-4o outage notice. The model list has no entries from later model generations. (`git log -1`; `README.md`)
