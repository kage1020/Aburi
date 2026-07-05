---
"@aburi/core": minor
---

Add the scan orchestration layer under `packages/core/src/scan/` — the wire that turns a workspace + configured plugin set into a canonical IR. Delivers every WI-11 acceptance criterion end-to-end:

- **File discovery** (`discoverFiles`) — glob-driven, respects the core Category A ignore set (`node_modules/`, `dist/`, `*.d.ts`, snapshots, framework caches …), `config.ignore[]`, `.gitignore` (togglable via `respectGitignore`), language-plugin `fileDropPatterns`, and `config.maxFileSizeBytes` with a 2 MiB default. Returned paths are POSIX-relative to the workspace root and sorted asciibetically for determinism.
- **Language routing** (`buildLanguageRouter`) — case-insensitive extension → LanguagePlugin dispatch. Extension collisions across two plugins throw at build time with a `CoreError("language-routing-collision")`.
- **Soft classify timeout** (`classifyWithTimeout`) — wall-clock enforcement around `EffectPlugin.classify`. Timeouts return `null` (the next plugin gets a chance) and fire an `onTimeout` hook that populates `stats.effectClassifyTimeouts[]`. A classifier that violates the sync contract by returning a Promise is treated as a timeout instead of stalling the scan.
- **Category B drop** (`decideSymbolDrop`) — interface / type-alias / empty function body / re-export marker. A boundary decorator always overrides the shape rule.
- **Category C drop** (`buildDropCFilter`) — core `console.*` / `process.std{out,err}.write` prefixes, `config.suppress[]` additions, effect-plugin `dropCallees[]` additions, `config.keep[]` exceptions. Precedence: keep > suppress > core / plugin. Prefix matching honors identifier boundaries (`console` does not match `consoleWrap`).
- **Per-file pipeline** (`runFilePipeline`) — parse → extractSymbols → framework classifySymbol (first-match-wins, merges extKind + decoratorBoundaries + derivedBy) → drop-B check → walkBody → drop-C call filter → effect classifySymbol (first-match-wins with timeout) → normalizeAst → `computeSymbolFingerprint`. Dropped Symbols carry `dropped: true` + `dropReason` and receive the ZERO fingerprint on every axis.
- **Top-level scan** (`scan`) — assembles the IR (Symbols + Components + Dependencies + Stats + Workspace + Generator + Plugins), sorts every array per the schema's ordering rules, and runs `assertIRIntegrity`. The 11 invariants pass before the IR is handed back to the caller.
- **Canonical output** (`writeCanonicalIR`) — writes the IR to `<output-dir>/aburi.ir.json` via `serializeCanonical`, so the file is byte-stable across runs.

### Public API

`scan`, `writeCanonicalIR`, `discoverFiles`, `buildLanguageRouter` / `LanguageRouter`, `buildDropCFilter` / `DropCFilter`, `decideSymbolDrop`, `runFilePipeline`, `classifyWithTimeout`, plus supporting types (`ScanInput`, `ScanResult`, `DiscoverOptions`, `DiscoverResult`, `FilePipelineInput`, `FilePipelineResult`, `ClassifyTimeoutEvent`, `ClassifyWithTimeoutOptions`, `DropCFilterInput`) and constants (`DEFAULT_MAX_FILE_SIZE_BYTES`, `DEFAULT_CLASSIFY_TIMEOUT_MS`, `CLASSIFY_TIMEOUT_MIN_MS`, `CLASSIFY_TIMEOUT_MAX_MS`).

Two new `CoreError` codes: `language-routing-collision`, `scan-plugin-misconfigured`.

### Tests

38 new unit tests across `test/scan/{discover,route,drop-b,drop-c,timeout}.test.ts` cover every leaf module. End-to-end coverage lives in a new `@aburi/scan-e2e` private package with 7 tests that drive the full pipeline through the real `@aburi/lang-typescript`, `@aburi/framework-next`, and `@aburi/effects-prisma` plugins — the e2e package is a separate workspace to keep `@aburi/core`'s build graph acyclic.
