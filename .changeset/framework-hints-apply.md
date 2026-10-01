---
"@aburi/plugin-registry": minor
"@aburi/types": minor
"@aburi/config": minor
"@aburi/core": minor
"@aburi/cli": patch
---

`frameworkHints` works: a hint with an `extKind` no longer stops every command, and every rule is applied

A hint with an `extKind` stopped `scan`, `diff` and `explain` at startup with exit 1, because the
loader moves `framework:acme:controller` under `framework:hint:acme` as `config.md` §8.3.1 says,
and the registry refused that prefix as reserved. A hint without one loaded and changed nothing:
no code read the rules, so `boundary`, `derivedBy`, `drop` and every `classNamePatterns` rule were
accepted and ignored. The guide's example now scans to `extKind: "framework:hint:acme:controller"`
with `boundary: true` on `@AcmeController`, and `framework:hint:acme:handler` on `OrderHandler`.

- `@aburi/plugin-registry`: `VocabRegistry.registerHint(manifest)` admits a namespace under the
  reserved `framework:hint`, and only there. `register` still refuses it, so a plugin listed in
  `frameworks` cannot claim one, and a hint still cannot claim `framework:hint` itself.
- `@aburi/config`: `frameworkHintPlugins(config)` builds a framework plugin per entry, and
  `LoadedConfig.syntheticPlugins` now holds those plugins rather than their manifests (read
  `.manifest` for what it held before; `normalizeFrameworkHints` still returns the manifests).
  Decorator rules match the decorator's leaf name, class-name rules match a class's own name
  against a glob (`*`, `?`), and the first `extKind` among the rules that apply wins.
- `@aburi/types`: `FrameworkPlugin` gains an optional `symbolDropHint`, the route a hint's
  `drop: true` takes into Category B. `@aburi/core` asks every framework plugin for it, whichever
  one classified the Symbol, after the core's shape rules and before the language plugin's. A
  hint drop is recorded as `frameworkHints "acme": @AcmeInternal` or
  `frameworkHints "acme": class *Handler`, and a Symbol with a boundary decorator is kept.
- `@aburi/cli`: hint plugins run after every plugin in `frameworks`, so a class a configured
  plugin recognizes keeps that plugin's classification. A hint the registry refuses (two entries
  writing the same vendor, or a `derivedBy` prefix a configured plugin owns) is a config error
  (exit 2) naming the entry, rather than a bare registry error on exit 1. The IR's
  `generator.plugins` lists each hint as `hint-<name>`.
