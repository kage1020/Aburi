---
"@aburi/cli": patch
"@aburi/config": patch
"@aburi/core": patch
"@aburi/diff": patch
"@aburi/effects-nest": patch
"@aburi/effects-prisma": patch
"@aburi/framework-nestjs": patch
"@aburi/framework-next": patch
"@aburi/lang-typescript": patch
"@aburi/markdown-projection": patch
"@aburi/plugin-registry": patch
"@aburi/types": patch
---

Ship the v0.1 documentation set required by WI-17.

- **Root `README.md`** — rewritten from a status placeholder into a full quick
  start: install / init / scan / diff / GitHub Action, a "why not just `git diff`"
  motivation with the four canonical scenarios, an architecture-at-a-glance
  block that walks source → IR → derived views, and a package matrix pointing
  at every workspace member.
- **Per-package `README.md`** — 12 new files (`@aburi/types`,
  `@aburi/plugin-registry`, `@aburi/config`, `@aburi/core`,
  `@aburi/lang-typescript`, `@aburi/framework-nestjs`, `@aburi/framework-next`,
  `@aburi/effects-prisma`, `@aburi/effects-nest`, `@aburi/diff`,
  `@aburi/markdown-projection`, `@aburi/cli`). Each covers the pitch, install,
  the shape of the API the package exports, and design-doc references.
  `@aburi/github-action` already had one from WI-15 and is untouched.
- **`docs/cli-reference.md`** — operator-facing per-subcommand reference for
  `aburi init / scan / diff / explain`: flags, `--fail-on` grammar, exit-code
  table, environment variables, config discovery order, and programmatic entry
  points.
- **`docs/plugin-development.md`** — walkthrough for authoring `LanguagePlugin`
  / `FrameworkPlugin` / `EffectPlugin`, the manifest contract, the two-signal
  layered gate convention for effect classifiers, testing pattern, and CLI
  loader resolution rules.

Docs-only change. Patch-bump every public package so the `files: ["dist", "src",
"README.md"]` package.json entry ships the freshly written README when the
next release is cut.
