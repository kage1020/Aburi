# @aburi/diff

## 0.3.0

### Minor Changes

- 14d3aa7: Settle candidate pairings by score and id rather than by array order

  Stages 2 to 4.5 each choose among possible pairings, and each chose one head at a time,
  taking that head's best base immediately. Two defects followed.

  **A better pairing was passed over for a worse one.** For a realistic rename:

  ```
  findUserByEmailAddress x findUserByEmailAddress = 1.0000   <- the optimum
  findUserByEmailAddress x findUserByEmail        = 0.9167
  findUserById           x findUserByEmail        = 0.8333
  findUserById           x findUserByEmailAddress = 0.7857
  ```

  `findUserByEmail` sorts first, so it consumed the base `findUserByEmailAddress` at 0.9167 and
  the head of that same name was left with 0.7857 and reported as `added` — one qualified name
  appearing in the output as an addition and as the source of a move at the same time. The
  canonical id-ascending order `scan` emits is exactly the order that produces it.

  **The answer depended on the order of the input arrays.** All four stages resolved equal
  scores to whichever candidate came first, and stage 4.5 has only three possible scores, so
  almost every pairing there was decided that way. Stage 2 had the same defect for two files
  renamed onto one target. Permuting `symbols[]` changed the canonical bytes of `diff.json`.

  Both close with one change: enumerate the candidate pairings that clear their threshold and
  settle them in `(score descending, base.id ascending, head.id ascending)` order, taking a
  pairing when neither side is spoken for. The id keys are a total order only because ids are
  unique within a Document, which `buildDiff` now establishes before the first stage runs.

  The sweep is greedy, not an optimal assignment — a pairing can still be stranded when both
  of its partners are taken by higher-scoring ones. That is a deliberate stop: the case that
  misleads a reader is the _best available_ pairing being skipped, and this never does that.

  Unchanged: every threshold, every rationale, stage 3's unconditional single-candidate branch
  and the cascade that feeds it, and the rule that a signature-less head is never paired.

  Two side effects worth naming:

  - Stage 3 used to hand stage 4 a `remainingBase` reordered by fingerprint-bucket insertion,
    and stage 4.5 moved non-dropped symbols to the front of what it returned. Every stage now
    returns its inputs filtered, so the arrays keep the caller's order throughout.
  - Scoring the whole bucket for every head, rather than one that shrank as heads consumed it,
    roughly doubles the similarities stage 4 computes, and holds one record per candidate
    where the per-head loop held one in total. `createNameScorer` tokenises each distinct name
    once per matching pass instead of once per comparison, which more than covers the time: a
    bucket of 1000 a side goes from 2785 ms to 488 ms, and 2000 from 8789 ms to 3876 ms. The
    memory is a real trade and diff-algorithm.md §8.2 now carries the bound.
  - Stage 4.5 does not make that trade. Both halves of its score are equalities and only two
    scores can clear its threshold, so it applies the same order through a cursor per group
    rather than a candidate list — which matters because a group of dropped Symbols sharing a
    basename (`index.ts`) is a join that returns everything, the ordinary shape of the
    directory rename the stage exists to catch. It is now 40–120× faster than before with flat
    memory: 1000 a side goes from 214 ms to 5 ms, and the all-`index.ts` case from 590 ms to
    5 ms at 2000.

- 4a4296e: Pair dropped Symbols only on a signal that identifies one

  §3.4.5 pairs dropped Symbols on two coarse signals — the trailing segment of the qualified
  name and the file basename — and accepts either alone, on the stated grounds that dropped
  Symbols sit outside the IR's main review surface and a false pairing there costs little.

  A basename hit on `index.ts` is not a weak signal. It is the most common filename in a
  TypeScript monorepo, so every dropped Symbol of one kind under one matched every other:

  ```
  moved: ts:src/billing/index.ts#InvoiceDto -> ts:src/orders/index.ts#OrderDto
  moved: ts:src/auth/index.ts#LoginDto      -> ts:src/shipping/index.ts#ShipmentDto
  ```

  Every score ties at one half, so which unrelated class paired with which was decided by the
  tie-break. The pairings land in `summary.moved`, which `--fail-on moved` gates on, so the
  budget was being spent on the default case rather than an unusual one.

  A half now counts only when the key carrying it **identifies** a Symbol: exactly one dropped
  base and one dropped head of that kind hold it. A key several Symbols carry names a group,
  and a group is not a pairing — and with the fingerprint zeroed there is no second opinion to
  choose among its members with.

  What still pairs, because the key identifies in each case:

  - a renamed directory of DTO files — §3.4.5's own headline example, both halves
  - a renamed directory whose DTOs all live in one `index.ts` — the names carry it alone
  - a renamed file whose class kept its name
  - a renamed class whose file kept its name, where that basename is not shared

  "Exactly one" is counted over the Symbols the stage is handed. Stages 1 and 2 have taken
  theirs, so a key they emptied out identifies again — which is the ordinary way a shared
  `index.ts` still pairs unrelated symbols: three dropped classes under one, two unchanged and
  matched by id, and the basename identifies the two that remain. That is the question the
  stage is answering, and §3.4.5 now says so rather than leaving "exactly one" unqualified.

  Two consequences worth stating:

  - **The candidates carry no weight, so §3.8 no longer applies here.** A pairing both halves
    identify cannot be contested — both keys are sole on both sides and point at each other, so
    neither Symbol appears in any other candidate — and what remains, one base offered
    different heads by the two halves, the 0.5-per-half scale scored equally anyway. §3.8's
    sweep settles conflicts by score, and its licence to be greedy is that it never passes over
    the best available pairing; with no score there is no best, and it would drop one identified
    pairing for another over nothing but the id it sorts under. Three identified pairings over
    four Symbols where two can hold is not a hypothetical, so the stage takes a **maximum
    matching**: each axis identifies a Symbol at most once, so the candidates are the union of
    two matchings — paths and even cycles — where alternate pairings along each component are
    maximum and walking from a fixed end makes the choice among them canonical.
  - **The bound comes for free.** At most one pairing per identifying key over two axes, so the
    candidate list is linear in the dropped Symbols rather than in their pairs — which is what
    a shared basename used to produce, and the reason the stage needed a memory-driven sweep of
    its own. That one is gone.

  `docs/design/diff-algorithm.md` §3.4.5 also still carried the candidate-list pseudocode from
  before that specialised sweep, and §8.2 described the sweep itself. Both now match the code.

- 722903a: Refuse a repeated identity instead of answering with one entry missing

  `buildDiff` keys three collections by identity — Symbols by `id`, Components by `id`,
  Dependencies by the `(from, to, via)` triple — and checked none of them. A repeat did not
  crash; it produced an answer:

  - Two head Symbols under one id: stage 1's lookup map is last-write-wins, so the base Symbol
    paired with the second and the first appeared in neither `matched` nor `added` — `usedHead`
    then removed both. Base 1 / head 2 reported `changed: 1, added: 0`.
  - Two base Symbols under one id: both found the same head Symbol, which was classified
    twice — `changed: 1` and `unchanged: 1` for one Symbol.
  - The same past stage 1: stages 2 to 4.5 pair on other signals but track the base Symbols
    they have consumed by id, so a repeat was dropped there too.
  - Two Components under one id: the second replaced the first in the lookup map, and the
    surviving pair compared roots belonging to different entries — a reported change between
    two revisions that agree.
  - Two Dependencies on one triple: a spurious `added` + `removed` pair, which is exactly how
    §6.2 encodes a genuine direction or effect flip.

  A missing Symbol is indistinguishable from one that was never there, so `buildDiff` now
  raises `DiffError` with the new code `ir-identity-collision`, naming the side, the
  collection, the repeated value and both positions:

  ```
  baseIR.symbols[3] repeats the id "ts:src/a.ts#foo" first seen at index 1; stage 1 pairs
  Symbols by id and every later stage tracks the base Symbols it has consumed by id, so a
  repeat leaves one entry out of the diff entirely or classifies its counterpart twice
  (ir-schema.md §14 #1).
  ```

  Establishing an identity means reading it, so the same pass refuses an entry that is not an
  object or whose identity fields are not strings. Both failures were reachable and neither
  named the offending position: `symbols: [null]` reached `matchStageId` and failed on
  `null.id`, and a lone Symbol carrying no `id` had nothing to collide with, passed, and
  derived a Slice anchored on `undefined` — reported as `slice-invariant-violated`, the one
  code the CLI presents as a bug in Aburi rather than in the caller's IR. Fields beyond
  identity are still unchecked here; that is `checkIRIntegrity` #20's job, and the CLI applies
  it when reading an IR off disk.

  diff-algorithm.md §3.7 is the canonical statement of the rule, of why it is enforced at the
  diff entry point as well as at extraction time, and of why the check is scoped to identity
  rather than delegating to the whole integrity checker. The CLI maps the new code to
  `config-error` (exit 2); `classifyDiffError` is now exhaustive over `DiffErrorCode`, so a
  future code has to be placed in that table rather than defaulting into it.

### Patch Changes

- Updated dependencies [e2dab93]
- Updated dependencies [630460f]
- Updated dependencies [c825c74]
- Updated dependencies [b8763eb]
- Updated dependencies [85ade16]
- Updated dependencies [14bdb6b]
  - @aburi/core@0.3.0
  - @aburi/types@0.3.0

## 0.2.0

### Minor Changes

- b2f4382: Give `SymbolId`, `ComponentId`, and `SliceId` separate identities instead of three names for `string`.

  Aburi mints three kinds of identifier and each owns a namespace, but all three were the
  same type. `SymbolId` and `ComponentId` were bare aliases of `string`
  (`aburi.ir.v1.json#/$defs/*` are `{"type": "string"}`, and json-schema-to-typescript
  faithfully generates what the schema says); `SliceId` did not exist at all, so
  `SliceRecord.id` was `string` and `SliceRecord.members` was `string[]`. Nothing stopped a
  Component id being passed where a Symbol id was wanted, and `"slice:" + members[0]` — the
  Slice-id derivation — was an expression any file could open-code, because its result was
  assignable to the field it fed.

  `SymbolId` and `ComponentId` are now nominal types, `SliceId` exists and is nominal too,
  and `dependencies[].from` / `.to` are `SymbolId | ComponentId` rather than `string` — the
  union is honest about the one array that holds both kinds, while still refusing an
  arbitrary string. Every brand comes from a constructor: `makeSymbolId` / `trySymbolId` /
  `makeComponentId` in `@aburi/core` and `sliceIdFor` in `@aburi/diff`. Assertions
  (`x as SymbolId`) survive in four documented places and nowhere else — `packages/core/src/id.ts`,
  `sliceIdFor` plus the untyped-input predicate in `packages/diff/src/slice.ts`, the single
  `parsed as unknown as IR` in `readIR`, and per-package test fixtures, which need to be able
  to write a malformed id for the cases that exist to reject one.

  Two call sites were building Symbol ids by concatenation behind a type annotation and now
  go through the constructor: the call-graph resolver and the LSP enrichment pass, which
  assemble _speculative_ callee ids and test them for existence. Those use `trySymbolId`, the
  non-throwing variant — an id that cannot be built is a callee that cannot exist, which is
  the same answer as a well-formed id absent from the Symbol table, so resolution behaviour is
  unchanged. `@aburi/diff`'s git-rename stage, which rebuilds an id around a moved file path,
  goes through the same constructor for the same reason.

  The brands are TypeScript-only and erased at runtime. Scanning and diffing the
  `nestjs-billing` fixture produces byte-identical `ir.json`, `diff.json`, `workspace.md`, and
  `diff.md` before and after.

  ### Schema

  `aburi.ir.v1.json` and `aburi.diff.v1.json` gain three `$defs` — `DependencyEndpoint`,
  `SliceId`, and a loose `SymbolId` on the diff side — extracted verbatim from the inline
  subschemas they replace. The validation semantics are identical; the change exists so the
  generator has a named alias to attach a brand to. The brand itself is applied by a
  post-processing pass in `packages/types/scripts/codegen-lib.ts`, not by a `tsType`-style
  keyword in the schema: these are frozen v1 documents published for validators outside this
  repository, and a non-standard keyword would make every strict-mode validator reject the
  schema itself. That is the same reasoning that kept the Slice anchor keyword out of the file.

  ### Two new integrity invariants
  - **#16 — no reserved namespace.** Slice ids are `"slice:" + <anchor Symbol id>`, so a
    language plugin claiming the token `slice` would mint Symbol ids indistinguishable from
    Slice ids and make the derivation produce `slice:slice:…`. Branding cannot fix this — the
    strings are genuinely the same shape — so `makeSymbolId` rejects the token, and
    `checkIRIntegrity` rejects it in a Symbol id or a Dependency endpoint from a document it did
    not build. Only the whole token is reserved; `slicer` is still legal. `@aburi/diff` reports
    it as its own `SliceRecord` violation kind too, because `buildDiff` is public API and runs
    no integrity check. No plugin uses `slice` today.
  - **#17 — ids satisfy their own grammars.** `readIR` brands a whole parsed document with one
    `as unknown as IR`, which is the only way to type a JSON parse — so ids read from disk used
    to acquire their brand without anything looking at them, while every other route ran a
    constructor. #17 closes that: `symbols[].id` must satisfy `isSymbolId` and `components[].id`
    must satisfy `isComponentId`. It is also what catches a language plugin that asserts the
    brand instead of calling the constructor.

  ### Behaviour changes
  - **`ComponentId` accepts a digit-leading segment.** The pattern was
    `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` and is now `^[a-z0-9]+(-[a-z0-9]+)*$`, in both
    `aburi.ir.v1.json` and `aburi.config.v1.json`. Component ids are derived by kebab-casing a
    package or directory name, and `3d-force-graph` / `7zip-bin` are ordinary npm names — the
    letter-first rule made the documented derivation partial for no benefit. Loosening a pattern
    is additive: every document that validated before still does.
  - **Component detection fails loudly on a name that yields no id at all.** After the pattern
    change only one case remains — a name that kebab-cases to the empty string. It now raises
    `invalid-component-id` naming the package or directory it came from, instead of putting `""`
    in `components[].id` and producing an IR that fails its own schema somewhere else entirely.
    The CLI wraps it as a `config-error`, so it exits 2 (input) rather than 1 (runtime).
  - **A Symbol id file path may not contain `:` or `#`.** They are the id's own separators, so a
    path holding either assembles into a string that still matches the schema pattern but splits
    back into parts the producer never wrote. `makeSymbolId` now refuses them, which is what lets
    `isSymbolId` recover the parts and re-run the constructor's own check.

  ### Packages with no source change

  `@aburi/config` and `@aburi/plugin-registry` are bumped for the `ComponentId` pattern change
  in `aburi.config.v1.json` and for the `@aburi/types` dependency, respectively; neither has a
  source diff.

  ### For plugin authors

  `SymbolCandidate.id` and `OwnerSummary.id` are `SymbolId` rather than `string`. A language
  plugin that already builds ids with `makeSymbolId` — as `@aburi/lang-typescript` does —
  needs no change. One that concatenates the parts itself will stop type-checking and should
  switch to the constructor, which enforces the `ir-schema.md` §3.1 grammar it was assuming.

- c913783: Enforce the `SliceRecord.id` anchor derivation instead of trusting it.

  `docs/design/slice-view.md` §7.1 defines a Slice id as `"slice:" + members[0]`,
  but `aburi.diff.v1.json` only constrains it with `pattern: "^slice:"`. Neither
  the derivation nor the §8.2 ascending `members[]` order can be written in
  JSON Schema 2020-12 — both compare one property against another — so
  `{ id: "slice:foo", members: ["bar", "baz"] }` validated cleanly, and a reader
  that reconstructed the anchor from the id would name a Symbol the Slice does
  not contain. `computeSlices` also had no post-condition of its own: that
  `members[0]` is the lexicographically smallest member held only because
  `computeWeaklyConnectedComponents` sorts each component, one layer below the
  pass and invisible from it.

  The derivation now lives in exactly one function, and `computeSlices` validates
  every `SliceRecord` it builds before returning it — an empty `members[]`, a
  non-strictly-ascending `members[]`, or an `id` that is not `"slice:" +
members[0]` raises `DiffError` with the new code `slice-invariant-violated`.
  Emitted output is byte-identical to before; the check only fires on a producer
  bug. `docs/design/slice-view.md` gains §7.4 describing the three enforcement
  layers, §8.2 now states that the member order is strictly ascending and why,
  and §13.7 adds the test criteria SV23–SV25.

  Public API additions:

  - `@aburi/diff`: `sliceAnchor(record)` returns `members[0]` — the anchor — and
    never derives it from `id`, so no consumer has a reason to strip the `slice:`
    prefix. `sliceRecordViolation(value)` takes `unknown` and reports which
    clause broke as a `SliceRecordViolation` (`kind` / `subject` / `message`), so
    a validator can classify a verdict without parsing prose and cannot crash on
    the untyped documents it exists to reject.
    `assertSliceRecordInvariant(record)` is its throwing form.
  - `DiffErrorCode` grows `"slice-invariant-violated"` (code additions are
    non-breaking).
  - `@aburi/cli`: `classifyDiffError(error)` maps a `DiffError` onto the exit-code
    table. `slice-invariant-violated` now exits 1 as a `runtime-error` naming
    itself an Aburi bug, instead of exit 2 as a `config-error` that would send the
    reader searching `aburi.json` for a fault that is not there. Every other
    `DiffError` keeps its existing exit 2.

  `@aburi/core` documents the two output-ordering guarantees
  `computeWeaklyConnectedComponents` has always provided — each component sorted
  by ascending key, components sorted by their first element — since Slice View's
  anchor rule depends on the first of them. `@aburi/markdown-projection` replaces
  a `members[0] as string` cast with a real check; it still reads `members[0]`
  directly rather than importing `sliceAnchor`, keeping the renderer free of a
  dependency on the engine that produces what it renders.

  `schema/aburi.diff.v1.json` is unchanged apart from two `description` strings
  recording that `id` is derived and that consumers read `members[0]`; those flow
  into the generated `SliceRecord` doc comments in `@aburi/types`. No keyword was
  added to the schema file: v1 is frozen and published for validators outside
  this repository, and a non-standard keyword there would make every strict-mode
  validator reject the schema itself. The derivation check is instead registered
  as an Ajv keyword by the validating consumer — `packages/diff/test/schema.test.ts`
  layers it onto the shipped schema and rejects a wrong anchor the same way a
  wrong prefix is rejected.

- f56e21b: Add Slice View clustering to `aburi diff`. Changed Symbols are grouped into
  weakly-connected components over the union of base and head call edges
  (Union-Find WCC), and rendered in `out/diff.md` under a new `## 🧵 Slice View`
  section positioned between `## 🔧 Logic changes` and `## ➕ Added`. Each Slice
  appears as a `### slice:<smallest-member-id>` heading with the member count
  and one bullet per member (short qname, status label, `file:line`, and a `↳`
  delta-axis summary). Singleton Slices collapse into one `<details>` "Standalone
  changes" fold. Empty `slices[]` omits the Markdown section entirely.

  Schema addition (non-breaking, additive per `ir-schema.md` §15.2): the
  `aburi.diff.v1.json` output now carries an optional top-level `slices` array
  whose entries are `{ id: string; members: string[] }`. The array is always
  emitted (empty when no Node-eligible change exists).

  Public API additions:

  - `@aburi/core`: `computeWeaklyConnectedComponents<TNode>` (generic Union-Find
    WCC utility) and `reconstructCallEdgesFromIR` (rebuilds `CallEdge[]` from a
    scanned IR's `Symbol.calls[].resolved` fields).
  - `@aburi/diff`: `computeSlices` + `SliceInput` — pure clustering function
    consumed by `buildDiff`.
  - `@aburi/types`: `SliceRecord` re-exported from the package barrel.

  No CLI flag was added and no `--fail-on` selector was extended, per
  `docs/design/slice-view.md` §11.4 / §14.7. The `slices[]` output is deterministic,
  idempotent, input-order-insensitive, and local under the guarantees enumerated
  in §10 of the same document.

### Patch Changes

- Updated dependencies [b2f4382]
- Updated dependencies [df2f3ec]
- Updated dependencies [2c5366d]
- Updated dependencies [14bcd59]
- Updated dependencies [efe3cbd]
- Updated dependencies [c913783]
- Updated dependencies [f56e21b]
  - @aburi/core@0.2.0
  - @aburi/types@0.2.0

## 0.1.0

### Minor Changes

- 121c177: Add the semantic diff engine — `@aburi/diff` — that compares two `aburi.ir.v1` documents and emits an `aburi.diff.v1`-conformant JSON projection tuned for PR-review workflows. Implements the full contract from `docs/design/diff-algorithm.md`.

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

- 358f76f: Cut the initial `0.1.0` release of the Aburi ecosystem.

  This is the first public version of every workspace package that ships. The
  v0.1 scope defined in [`docs/roadmap.md`](https://github.com/kage1020/Aburi/blob/main/docs/roadmap.md)
  is complete:

  - **Foundation** — `@aburi/types` (schema-generated + hand-written interfaces),
    `@aburi/plugin-registry` (vocab registry + conflict enforcement),
    `@aburi/config` (JSONC + ajv-validated loader with framework-hint
    normalisation), `@aburi/core` (Symbol id, canonical JSON, 11 IR invariants,
    autodetect, scan orchestration).
  - **Language** — `@aburi/lang-typescript` (tree-sitter WASM TS/TSX plugin).
  - **Frameworks** — `@aburi/framework-nestjs`, `@aburi/framework-next`.
  - **Effects** — `@aburi/effects-prisma`, `@aburi/effects-nest`.
  - **Diff + projection** — `@aburi/diff` (5-stage semantic matcher +
    status + delta), `@aburi/markdown-projection` (workspace / component / diff
    / explain views).
  - **Delivery** — `@aburi/cli` (`aburi init | scan | diff | explain`, exit codes
    0 / 1 / 2 / 3, `--fail-on` gate), `@aburi/github-action` (composite action +
    marker-based PR comment upsert).

  ### Publishing pipeline
  - `.github/workflows/ci.yml` — matrix (ubuntu / macos / windows) runs Biome
    `check`, `typecheck`, `build`, `test` on every PR and every push to `main`.
  - `.github/workflows/release.yml` — on push to `main`, `changesets/action@v1`
    either opens a "Version Packages" PR (when there are pending changesets) or,
    if that PR was already merged, runs `pnpm release` (typecheck + test + build
    - `changeset publish`) to push every bumped package to npm.
  - Authentication uses [**npm Trusted Publishing**](https://docs.npmjs.com/trusted-publishers)
    (OIDC). No `NPM_TOKEN` secret is stored anywhere; pnpm 11.11.0 exchanges the
    workflow's OIDC token for a short-lived publish credential at publish time.
    Sigstore attestation is emitted via `provenance=true` in the workflow's
    `.npmrc`, and consumers verify tarballs with `npm audit signatures`.
  - `changesets/action` reads the `New tag: …` lines the publish command prints
    and creates a matching GitHub Release per per-package tag
    (`@aburi/<pkg>@0.1.0`).
  - Every public package.json carries `repository.directory` so npm links back
    to the correct monorepo subdirectory, plus explicit `author`, `homepage`,
    and `bugs` fields.

  ### One-time trusted-publisher setup (required before the first publish)

  For each of the 13 publishable `@aburi/*` packages, register a trusted
  publisher on npmjs.com pointing at this repository's release workflow:

  1. On the package settings page (e.g.
     `https://www.npmjs.com/package/@aburi/cli/access` — for a not-yet-published
     package, first do a one-time manual `npm publish` to reserve the name, or
     configure the trusted publisher on the org account before publishing).
  2. Under "Trusted Publisher", add:
     - **Provider**: GitHub Actions
     - **Repository**: `kage1020/Aburi`
     - **Workflow filename**: `release.yml`
     - **Environment**: leave blank (no environment gating today)
  3. Repeat for all 13 packages, or configure the trusted publisher on the
     `@aburi` org so newly-scoped packages inherit it.

  Once configured, no rotation, no secret storage, and no static credential is
  ever created. Revoking access is a one-click delete on the npm settings page.

  ### Consumer entry points at 0.1.0
  - `npm i -D @aburi/cli @aburi/lang-typescript @aburi/framework-<yours>`
    (see the [root README](https://github.com/kage1020/Aburi#readme) for the
    quick start).
  - `uses: kage1020/Aburi/packages/github-action@main` in a workflow to gate
    PRs on the semantic diff. The action is referenced by repo path (composite
    action convention), and the CLI version it invokes is picked by the workflow
    author via the `version` input, so future CLI patch releases roll out to
    consumers without a fresh action tag. When per-release ref pinning is
    wanted, use the per-package tag `changesets/action` creates
    (`@aburi/github-action@0.1.0`) — an unscoped `v0.1.0` tag is intentionally
    not published because `changeset publish` names monorepo tags per package.

### Patch Changes

- 405dcfa: Ship the v0.1 documentation set.

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
    `@aburi/github-action` already had one and is untouched.
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

- Updated dependencies [19f2494]
- Updated dependencies [a8882f0]
- Updated dependencies [8510fb1]
- Updated dependencies [969c4eb]
- Updated dependencies [f8598d1]
- Updated dependencies [115be7a]
- Updated dependencies [405dcfa]
- Updated dependencies [358f76f]
  - @aburi/types@0.1.0
  - @aburi/core@0.1.0
