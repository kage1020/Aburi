---
"@aburi/core": minor
---

Introduce the `@aburi/core` foundation package. Bundles the five primitives the extraction pipeline will sit on top of:

- **Symbol ID generator** — composes `<language>:<file>#<qualified-name>` deterministically, refuses anonymous position-dependent qualified names (the `<anon@L42>` family), refuses Windows backslashes / absolute paths / `..` ascents, and reserves `<default>` as the sole sentinel for unnamed default exports.
- **Canonical JSON serializer** — NFC-normalizes every string, sorts object keys by Unicode codepoint, preserves array order, and throws `non-plain-json` on functions / symbols / bigint / Map / Set / Date / class instances so silent coercion cannot corrupt downstream fingerprints. Supports `pretty` (2-space indent + LF) and `compact` modes.
- **IR integrity checker** — runs the 11 invariants enumerated in the IR schema in one pass (uniqueness, referential integrity, conditional shape, enum membership, extKind pattern, POSIX paths, array sort order), returns every violation as a structured list, and offers a throwing variant that aggregates them into one `CoreError`.
- **Workspace root + manager detection** — walks parents to find the outermost workspace marker (`.git`, `pnpm-workspace.yaml`, `turbo.json`, `nx.json`, `lerna.json`, `go.work`, workspace-aware `package.json` / `Cargo.toml` / `pyproject.toml`), then resolves pnpm / npm / yarn / bun / turbo / nx into `WorkspaceManager[]` and a flat candidate list.
- **Component autodetect (JS/TS)** — derives one `Component` per workspace candidate (id from `package.json#name`, name kept verbatim, languages from depth-3 extension frequency, frameworks from dependency manifests, publicApi from `exports` / `main` / `module` / `types`), resolves id collisions via parent-directory suffixes, and falls back to a single-project Component when no manager fires.

Public API: `makeSymbolId` / `makeMemberQname` / `makeNestedQname` / `makeTopLevelQname` / `toPosixRelative` / `DEFAULT_EXPORT_QNAME` / `isDefaultExportQname`, `serializeCanonical`, `checkIRIntegrity` / `assertIRIntegrity`, `detectWorkspaceRoot` / `detectManagers`, `detectComponents`, plus `CoreError` with discriminated codes (`anonymous-symbol-id-attempted` / `non-posix-path` / `invalid-language-id` / `non-plain-json` / `integrity-violation` / `workspace-root-not-found` / `workspace-manifest-malformed`).
