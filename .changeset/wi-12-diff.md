---
"@aburi/diff": minor
---

Add the semantic diff engine — `@aburi/diff` — that compares two `aburi.ir.v1` documents and emits an `aburi.diff.v1`-conformant JSON projection tuned for PR-review workflows. Delivers every WI-12 acceptance criterion from `design/details/diff-algorithm.md`.

### Matching pipeline (5 stages)

- **Stage 1 — exact id match** (`matchStageId`) — hash-map lookup; the highest-confidence signal.
- **Stage 2 — git rename** (`matchStageGitRename`) — rewrites the base id with the head-side file path when a `git diff --find-renames` map is supplied. Missing map (or empty) skips the stage cleanly.
- **Stage 3 — logic-fingerprint match** (`matchStageLogicFingerprint`) — buckets base by `fingerprint.logic`. Single-candidate hits pair with `logic-fingerprint`; multi-candidate hits fall back to name-similarity disambiguation with a 0.85 floor. Dropped Symbols (zeroed fingerprint) are excluded to prevent the whole population from colliding at `"000000000000"`.
- **Stage 4 — name + signature similarity** (`matchStageNameSignature`) — `(kind, signatureNullness)` bucket pre-filter; score = `0.5·nameSimilarity + 0.3·signatureSimilarity + 0.2·ownerSimilarity` with kind-aware threshold table (1-token → 1.0, 2-token → 0.95, else 0.85). Both-signatureless pairings are skipped to keep `sig=null+null` from returning 1.0 across the whole class body.
- **Stage 4.5 — dropped weak matcher** (`matchStageDroppedWeak`) — same-kind fallback for dropped Symbols using `lastSegment(name) + basename(file)`; threshold 0.5 (either half is enough) so directory renames of DTO folders show up as `moved` rather than `droppedRemoved + droppedAdded`.

### Delta and status

- **Status classifier** (`classifyStatus`) — `dropped-toggled` absolutely dominates (§4.1); otherwise path-or-id change and fingerprint change compose into `moved` / `changed` / `moved+changed` / `unchanged`. In-file rename (id changed, path same, fingerprint same) is `moved` per DF9.
- **Symbol delta** (`computeSymbolDelta`) — three fingerprint booleans + array deltas for rules / effects / calls / decorators with configurable line fuzz (default 2, max 10). Decorator identity is `name`; argument-list differences produce `modified`. Signature delta emits inputs / outputs / throws sub-deltas plus `async` / `generator` / `typeParameters` change flags. Line fuzz is delta-only (fingerprints already exclude line info).
- **Component diff** (`diffComponents`) — id-keyed, `changed[]` entries carry `rootsChanged` / `publicApiChanged` / `frameworksChanged` booleans (no `modified` per §6.1).
- **Dependency diff** (`diffDependencies`) — `(from, to, via)` triple key. Direction / effect changes are recorded as an added + removed pair (no `modified` per §6.2).

### Public API

`buildDiff`, `writeCanonicalDiff`, `computeSymbolDelta`, `classifyStatus`, `dropDirection`, `diffComponents`, `diffDependencies`, `matchStage{Id,GitRename,LogicFingerprint,NameSignature,DroppedWeak}`, `nameSimilarity`, `ownerSimilarity`, `signatureSimilarity`, `tokenizeName`, `jaccard`, `lastSegment`, plus supporting types (`DiffInput`, `SymbolPair`, `SymbolStatus`, `DropDirection`, `DeltaOptions`, `GitRenameMap`, `DiffError`, `DiffErrorCode`, `DiffErrorDetail`) and constants (`DEFAULT_LINE_FUZZ`, `MIN_LINE_FUZZ`, `MAX_LINE_FUZZ`).

Two new `DiffError` codes: `schema-mismatch`, `invalid-line-fuzz`.

### Tests

47 new tests across `test/{df-properties,match,similarity,canonical}.test.ts` cover DF1..DF18 + DF14b (dropped weak match by basename), the 5-stage matcher in isolation, similarity + owner tokenisers, and byte-deterministic canonical output stability.
