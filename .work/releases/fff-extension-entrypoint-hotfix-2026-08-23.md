---
release: fff-extension-entrypoint-hotfix-2026-08-23
date: 2026-08-23
packages:
  - "@nklisch/pi-fff-compat@0.1.3"
  - "@nklisch/pi-enhanced@0.2.2"
items:
  - fix-fff-extension-entrypoint
---

# FFF extension entrypoint hotfix — 2026-08-23

Pi FFF compatibility and the enhanced bundle now declare `fff-compat-search.ts` as the extension entrypoint instead of declaring its containing source directory. Pi therefore no longer attempts to load `finder-lifecycle.ts`, a helper module without a default extension factory, as an extension.

## Verification

- The installed enhanced manifest was repaired and `pi --list-models` completed with normal extension loading.
- Manifest and packed-bundle regression tests pin the direct entrypoint.
- The authoritative `npm run check` passed and packed all eleven workspaces.

## Publication receipts

Trusted-publishing workflow: [GitHub Actions run 32667973894](https://github.com/nklisch/pi-extensions/actions/runs/32667973894), successful on 2026-08-23.

- `@nklisch/pi-fff-compat@0.1.3` — `sha512-pCVXLsyTlV/OUgDFzB3A9UhQtvb2gJxrg8dkeCSDACMPEIcbl5naeu2AJylBOrsBbWVkLOQaDRjRUAGfxW3k7Q==`
- `@nklisch/pi-enhanced@0.2.2` — `sha512-j7ITB7rUriOOy2LcMLj/FqbR+9fxeN8MN2SJrGjOglPgPEmWhZzHWc0vVtioX70gEWT/ohIU74M5TbGeMR/SkA==`
