# @aburi/diff

## 0.4.0

### Minor Changes

- a358a5a: Name the field a diffed IR is missing, instead of crashing on it

  `buildDiff` is public API and ran no integrity check, so an IR a caller assembled in memory
  reached the matcher unverified. Every field the diff dereferences crashed it with a bare
  `TypeError` naming neither the record nor the field — measured, one field deleted at a time
  from a well-formed pair:

  | deleted                                                | crashed in                                                            |
  | ------------------------------------------------------ | --------------------------------------------------------------------- |
  | `symbols[].fingerprint`, `.source`                     | `classifyStatus`                                                      |
  | `symbols[].calls`, `.decorators`, `.effects`, `.rules` | `computeSymbolDelta`                                                  |
  | `components[].roots`                                   | `diffComponents`                                                      |
  | `stats`                                                | `dependencySideView`, which reads `stats.skippedFiles` off every side |

  That list is the shape of the class rather than the whole of it: it is one matcher change
  away from being out of date, which is the argument for a gate that is not scoped to it.

  `buildDiff` now runs `checkDocumentShape` on each side before the identity pass. The refusal
  is a `DiffError` with code `ir-shape-invalid`, naming the side, the record and the field:
  `headIR.symbols[3]: "fingerprint" is absent, not an object.` A breach at the top level has no
  index to name and says so — `headIR: "stats" is absent, not an object.`

  **Invariant #20, and only #20.** The semantic invariants are statements about a Document whose
  answer the diff does not depend on — an unsorted `symbols[]` diffs correctly, because stage 1
  keys by id — so running them would withhold an answer the matcher can give, and `aburi diff`
  would re-pay the full checker on a Document `readIR` already checked. It re-pays the structural
  walk instead: 1.8ms per side at 1,000 Symbols, 17ms at 10,000.

  **This refuses IRs that used to produce an answer.** A Symbol missing `visibility`, `name` or
  `kind` was diffed happily, because nothing in the matcher dereferenced it; so was a Document
  with no `generator` or `workspace`. The gate is scoped to what the `IR` brand asserts rather
  than to what today's matcher touches: a scope that moved with the matcher would leave a
  caller's Document conditionally valid, and `integrity-shape.ts` makes that argument for itself
  while naming this consumer.

  `DiffErrorDetail` gains `violations?: readonly IntegrityViolation[]`, matching
  `CoreErrorDetail`. The message quotes the first breach and counts the rest, which is enough to
  start on and not enough to finish; the array carries all of them, each subject prefixed with
  the side it came from. Additive — no existing field changed.

  `checkDocumentShape` and `DOCUMENT_SUBJECT` are now exported from `@aburi/core`. The first was
  module-exported only, reachable solely through `checkIRIntegrity`, which runs it and then the
  semantic checks this deliberately avoids. The second is what tells a root-level breach from a
  nested one, and a hand-copied literal on the diff side would go quietly wrong if core renamed
  it.

  The messages are the ones `checkDocumentShape` writes, subject naming the record and message
  naming the field, rather than a second wording for the same breach — including the empty
  `$schema`, which is `buildDiff`'s own requirement and now reads in the same shape. Callers
  matching on `DiffError.message` for a malformed Document see the new form; `code` is unchanged.

### Patch Changes

- Updated dependencies [be8e2b9]
- Updated dependencies [81dadb6]
- Updated dependencies [a358a5a]
- Updated dependencies [3774de6]
- Updated dependencies [ff059d7]
- Updated dependencies [6676ca7]
- Updated dependencies [6d4730f]
- Updated dependencies [e7f1d49]
- Updated dependencies [203ea78]
- Updated dependencies [3e180e8]
- Updated dependencies [a4d3cff]
- Updated dependencies [ba9e505]
  - @aburi/types@0.4.0
  - @aburi/core@0.4.0

## 0.3.0

### Minor Changes

- 5c36d16: Relicense from MIT to the Apache License 2.0.

  The terms are still permissive, and nothing about how you may use, modify, or
  redistribute Aburi narrows. Apache 2.0 adds two things MIT leaves unsaid: an
  express patent grant from every contributor, and a termination clause that
  withdraws it from anyone who brings a patent claim over the work. Redistributors
  now also carry two obligations MIT did not impose. State the changes you made to
  any file you modified, and pass along the `NOTICE` file.

  Each package now ships a copy of the licence in its own tarball, which Apache
  2.0 section 4(a) asks for and the SPDX field alone did not satisfy.

  Versions published before this change stay under MIT. A licence already granted
  cannot be withdrawn, so anyone depending on an earlier release keeps the terms
  they got.

- f73eb46: Name the files neither revision analysed, in the diff rather than only on stderr

  `SymbolChange.status: "unknown"` covers a file **one** scan lost: the other document still holds
  its Symbols, the matcher has leftovers, and each one gets a status saying the answer is missing.
  A file skipped on **both** sides leaves no Symbols anywhere, so there is no leftover, no entry,
  and the diff said nothing at all:

  ```
  base, vendor/bundle.js skipped (over-size) → no Symbols from it
  head, vendor/bundle.js skipped (over-size) → no Symbols from it

  summary:      +0 -0 ~0 ↔0 ⤴0
  diff.json:    nothing
  diff.md:      nothing
  exit:         0
  ```

  Which is indistinguishable from having compared the file and found it unchanged.

  **This is the ordinary case, not the exceptional one.** Most skip reasons are deterministic
  properties of the file rather than of the revision — `over-size` on a generated bundle,
  `unroutable` on a language no loaded plugin claims, `parse-failed` on a file broken since before
  the branch was cut. So a workspace with a standing blind spot got a clean-looking diff on every
  pull request while a whole directory sat outside the comparison.

  `aburi diff` already named those paths on stderr. That is a cover note, not the artifact: a
  `diff.json` handed to a bot, or a `diff.md` pasted into a review, carried no trace — the same gap
  `stats.skippedFiles` closed on the IR side.

  **What was added**

  `DiffResult.notCompared[]`, one entry per path both skip lists hold, carrying `baseReason` and
  `headReason`, sorted by path. `diff.md` gains a `## 🚫 Not compared` section beside Unknown.

  - **A document-level field rather than a new status.** The diff has nothing to say about such a
    file at the Symbol level, because it has no Symbols from it on either side. The honest
    statement is about the run.
  - **The intersection, not the union.** A one-sided loss is already reported as `unknown`;
    listing it here as well would count one loss twice in two vocabularies that mean different
    things.
  - **Both reasons, never one.** They can differ — `parse-timeout` at the base and `over-size` at
    the head is one file that timed out once and is permanently too large — and the pair is what
    tells a reader whether a re-run is enough. The Markdown collapses them to one phrase only when
    they agree.
  - **No summary counter.** `unknown` and `depsUnknown` complete a census: they correct the
    counters beside them, which are undercounts by exactly that much. These files contributed no
    entry to any array on either side, so there is nothing to correct — the field scopes the
    document rather than qualifying a count.

  **Emitted unconditionally, empty array included.** The IR's convention for a field like this is
  Class B — omit the key when empty; the diff's is the opposite, per
  `docs/design/diff-algorithm.md` §10.1. An IR reader can fall back on `totalFiles - parsedFiles`
  to tell "nothing was lost" from "this writer could not say"; a diff reader has nothing to fall
  back on, so the writer says it. Schema-optionality covers only documents written before the field
  existed, and the Markdown section is omitted for those rather than reporting a clean run.

  **Not in scope.** `--fail-on` gains no token. A workspace with a permanent over-size bundle would
  trip a bare one on every pull request, which is an argument for a threshold rather than a flag,
  and the same question is already open for the dependency side.

  Nor does an entry carry a `detail`. Ref mode could supply one — it keeps both `ScanReport`s, and
  each `skipped` entry there has the size, the elapsed or the message a plugin refused the file
  with — but file mode runs no scans and never could, so the field would be present or absent for
  the same workspace depending on how the diff was invoked. It is also what the IR refuses to
  persist for the same reason (`ir-schema.md`, `SkippedFile`): an `unreadable` detail is an OS
  error message carrying an absolute path, and a canonical document whose bytes depend on where
  the repository was checked out is not byte-stable. This field carries exactly what
  `stats.skippedFiles` persists, which is what makes it available from both modes.

  Every `diff.json` gains the key, so a byte-exact or snapshot comparison against one written by an
  older version will differ.

  Verification: 9 cases in `packages/diff/test/not-compared.test.ts`, five ajv instance cases, one
  canonical byte-stability case that reverses both skip lists, five projection cases, and the CLI's
  symmetric-loss case extended to read the artifact it wrote rather than the value it returned. The
  primary fixture skips the same path for _different_ reasons on the two sides, because every
  fixture where they agree is blind to the two being swapped.

- 4c2d5aa: Record what the scan lost, and stop calling it removed API

  A file the scan gave up on left no trace **inside** the IR. `ScanResult.skipped` and
  `ScanResult.extractionFailures` are siblings of `ir`, and `writeCanonicalIR` serialises `ir`
  alone, so `out/aburi.ir.json` said only that `parsedFiles` was below `totalFiles` — which is
  equally true of an over-size file, a timed-out one and a withdrawn one, and names none of
  them.

  The next `aburi diff` then read every Symbol in that file as deliberately deleted API:

  ```
  scan @ main       → 400 symbols
  scan @ PR branch  → src/route.ts withdrawn, 380 symbols
  aburi diff        → 20 symbols "removed"
  --fail-on removed → trips, reporting an API deletion nobody made
  ```

  The scan's exit code was the only signal, and an exit code does not travel with the
  artifact. `parse-timeout` was the sharpest case: whether a file times out depends on how
  loaded the machine was, so the same commit produced the phantom on one run and not the next.

  ## `stats.skippedFiles[]`

  The Document now names them: `{ path, reason }[]`, sorted by path, one entry per file the
  scan stopped working on, whatever stopped it. The name is the one `component-detect.md`,
  `drop-list.md` and `lang-plugin.md` have each pointed at as planned.

  Class B per `ir-schema.md` §1.1 — the key is omitted when nothing was lost, so its presence
  answers "did this run drop anything" on its own, and absence _with_ `totalFiles > parsedFiles`
  identifies a document written before the field rather than a clean run.

  **No `detail`.** The scan carries one per entry — the size, the elapsed, the message a plugin
  refused the file with — but the `unreadable` detail is an OS error message containing the
  **absolute** path, and a canonical document whose bytes depend on where the repository was
  checked out is not the byte-stable artifact everything downstream assumes.

  Integrity **invariant #21**: when present, `skippedFiles.length === totalFiles - parsedFiles`
  and no path appears twice. This is a **read-side** check — inside Aburi's own scan both sides
  reduce to the same sum of the same two counts, so it cannot fire on a document Aburi wrote.
  What it guards is a document arriving through `readIR`, hand-edited or from another generator,
  that `aburi diff` is about to read to decide an absent Symbol is a loss rather than a deletion.
  Conditional on presence, because a document that predates the field cannot satisfy it and its
  absence is itself the answer.

  It does not cover a file that parsed successfully and yielded no Symbols: counted in
  `parsedFiles`, in no array, satisfying the check, and its Symbols still reported as removed.
  Withdrawal takes a plugin saying so, so a plugin that swallows its own error and returns an
  empty Symbol list withdraws nothing.

  `workspace.md` gains a "Files not analysed" section grouping the paths by reason, so a reader
  holding only the Markdown sees the same thing.

  ## `status: "unknown"`

  `aburi diff` reads that list. A leftover Symbol whose `source.file` the _other_ document never
  analysed is no longer `removed` (or `added`) but `unknown`, carrying `absentFrom` — the
  document that lost the file, so `head` reads as "this may still exist" and `base` as "this may
  not be new" — and the skip `reason`, which is what decides the reader's next move.

  Three properties this rests on:

  - **Classified after the five matching stages, never before.** A Symbol that moved _out of_ a
    lost file into a file the other document has is matched by stage 3 or 4 and stays `moved` —
    that document holds real evidence for it. Filtering the base list up front would throw the
    answer away.
  - **Both directions.** A file fine at head and withdrawn at base makes phantom `added` entries
    exactly as the reverse makes phantom `removed` ones.
  - **`dropped` leftovers keep their counters.** They produce no `symbols[]` entry on either
    side today and nothing gates on them, so `droppedAdded` / `droppedRemoved` still count them
    rather than gaining entries where there were none. Stated rather than silently different.

  A status of its own rather than the alternatives: suppression hides a Symbol that may
  genuinely have been deleted, and `removed` plus a flag shows an API deletion to every reader
  that does not know to look — including `--fail-on removed`, which is the whole reason the
  phantom mattered.

  `SymbolChange` gains a member, which is breaking for an exhaustive `switch` over `status`.
  `Summary.unknown` is optional rather than required, so a diff written before the counter stays
  schema-valid; `--fail-on unknown` counts the entries rather than reading it, so the gate
  answers about the document rather than about which writer produced it.

  ## What a reader sees

  ```
  ⚠ head IR reports 3 file(s) it did not parse but has no stats.skippedFiles to name them, …
  ```

  when a document dropped files but predates the field. `buildDiff` cannot invent the list —
  inferring it from `totalFiles > parsedFiles` would attach the doubt to whichever Symbols
  happened to be missing — so it reports what it can see, and the CLI says what it could not
  check. Both sides are examined.

  `diff.md` gains an `❔ Unknown` section directly after Removed, naming the file, the side that
  lost it and why. **Both** summary lines — the word form in `diff.md` and the glyph form on
  stdout — grow `· ?N unknown` when there is one, and neither carries a permanent `?0` when there
  is not. The glyph line matters most: with `stats.skippedFiles` present on both sides the stderr
  warning cannot fire, so it is the only place a run that lost a file says so without
  `--fail-on unknown`. `aburi diff` now renders it through
  `@aburi/markdown-projection`'s `projectDiffSummaryLine` rather than a byte-identical private
  copy, which is how the two came to disagree.

  `workspace.md`'s header reports `parsedFiles` beside `totalFiles` whenever they differ, so a
  document that lost files but predates `stats.skippedFiles` no longer renders byte-identically
  to a clean scan — the projection is a pure function with no stderr to fall back on.

  A file skipped by **both** scans produces no `unknown` entry: neither document holds Symbols
  from it, so the matcher has no leftover to classify. Most skip reasons are deterministic
  properties of the file, which makes symmetric loss the ordinary case rather than the
  exceptional one, and the diff would otherwise look exactly like one that compared the file and
  found it unchanged. `aburi diff` names those paths on stderr, capped. Representing them inside
  `diff.json` is left open: the only thing to say about such a file is that neither side read it,
  which is a statement about the run rather than about a Symbol.

  ## Not closed by this

  `aburi scan` still exits `0` when a plugin refuses every file in the workspace — the document
  now says so, but nothing gates on it.

  `aburi explain` and `aburi diff` still discard the incident report of the scans they run
  themselves, so a Symbol in a file the scan refused is answered with `No matches` rather than
  with a reason.

  `dependencies[]` is projected from the call graph, so a lost file's Symbols take their edges
  with them and `summary.depsRemoved` reports exactly the confidently-wrong deletion this change
  fixed for `symbols[]`. `unknown` is a `symbols[]` status only.

  Each of the three is tracked as its own issue.

- a5ffc07: Stop pairing Symbols whose name says one word

  §3.4.3 asks a higher score of a shorter name, and the row for a one-token name reads 1.0.
  That was written as an impossible score to demand — the shield against short-name false
  positives. It is a reachable one: an identical name, an identical signature and an identical
  owner give `0.5 + 0.3 + 0.2`, exactly 1 in IEEE 754. So the row admitted precisely the
  pairings it was meant to refuse:

  ```
  moved+changed  ts:src/legacy/runner.ts#main -> ts:src/tools/scaffold.ts#main
  ```

  Two unrelated top-level `main(x: string): void`. Everything the score read was one word and a
  signature half a CLI shares. With three a side every pairing ties at 1, so which unrelated
  `main` moved into which came down to the id §3.8 sorts on. These land in `summary.moved`,
  which `--fail-on moved` gates on.

  A bar above the top of the scale is not a threshold. Having too little to say is a property
  of the name, so it is now an admissibility rule alongside the signature-less one: a head
  whose qualified name carries a single distinct token is not read by stage 4 at all.

  Counted over the **whole qualified name**, which is what the score reads — not over the last
  segment, which is what `thresholdFor` reads. `UserRepo.get` supplies three tokens and goes on
  pairing though its last segment supplies one; tokens are deduped, so `Main.main` supplies one
  and does not.

  What is unchanged:

  - **The threshold table.** `UserRepo.get` is still held to a full 1.0 by the first row, and
    loses it to one added `throws`. The comparison stays `>=`, which is what lets that row pair
    at all.
  - **Stage 3.** An identical logic fingerprint is proof of its own and asks nothing of the
    name, so a `main` that moved file unchanged is still a move. Only the stage that reasons
    _from the name_ stopped reasoning from one word.

  The rule reads both sides of a pairing, since either end being short is enough to make the
  score unearned.

  **What this gives up.** A one-token name that moved file _and_ changed body is reported as
  `added` + `removed` where it was one `moved+changed`. The band is narrow — stage 1 takes it if
  the id survives, stage 2 if git recorded the rename, stage 3 if the logic fingerprint is
  unchanged — leaving a cross-file move git did not record, with an edited body.

  It is wider on codebases with non-Latin identifiers. `tokenizeName` finds camel boundaries by
  ASCII code-point range, so `ユーザー情報を取得する` and `获取用户信息` are one token each and
  are refused on the same footing as `main` — for those names the count is a bad proxy for how
  much the name says. The rule keeps the count rather than special-casing a script: the fix is a
  better measure in §3.4.1, which every caller of `tokenizeName` reads, so it belongs in its own
  change. §3.4.1 and §3.4.3 state the boundary and tests pin the behaviour.

- 916eae2: Make the owner a gate, so a renamed class keeps its methods

  §3.4.6 (R-8) has two jobs: pair `UserRepo.getUser` with `UsersRepository.getUser` when the
  class is renamed, and keep it away from `AdminRepo.getUser`, which is a different class. It
  could do neither, and all three of its worked examples disagreed with the code.

  **The owner was counted twice.** §3.4.1's name axis is a Jaccard over the _whole_ qualified
  name, so a renamed owner already depressed the name term, and the owner axis then charged for
  the same difference again at 0.2:

  ```
  UserRepo.getUser vs UsersRepository.getUser
    documented   0.5 + 0.3 + 0.1  = 0.9   passes
    measured     0.2 + 0.3 + 0.0  = 0.5   refused
  ```

  End to end, renaming a class and keeping three methods with edited bodies reported
  `added: 3 / removed: 3`.

  **And the owner was a weight, which cannot do R-8's job.** Reading the name axis on the last
  segment fixes the double count and inverts the ordering: `AdminRepo` _shares_ the `repo` token
  where `UsersRepository` shares none, so the pair R-8 must reject scores 0.8667 and the two it
  must accept score 0.8000. Raising the weight only moves the problem — at 0.2 two three-token
  class names sharing two tokens reach 0.9000, and at 0.3 they land on exactly 0.85, still above
  the table's lowest row. A perfect member name and a
  perfect signature will outvote any owner term small enough to leave the name axis meaning
  something.

  So the owner is a **gate**. Two owned Symbols may pair only if their owners name the same
  scope: segment for segment, and within a segment token for token, where two tokens match when
  they are equal or one is the other inflected (`user`/`users`, `entity`/`entities`). Past the
  gate there is no owner left to grade, so the axis is satisfied in full and the composite keeps
  the 0.5/0.3/0.2 shape §3.4.3's rows are calibrated against — dropping the term and
  renormalising would move every threshold without changing what any of them means.

  **Inflection, and nothing looser.** A prefix test is the obvious way to admit
  `repo` -> `repository`, and it cannot be made to work: it admits `repo`/`report`,
  `cache`/`cached`, `con`/`controller`, which are distinct classes and exactly the collision R-8
  refuses. Nor is there a threshold to find — the renames to accept score _lower_ than the
  collisions to refuse on every measure tried (`UserRepo`/`UsersRepository` is dice 0.571,
  `RepoManager`/`ReportManager` is 0.818; Levenshtein 7 against 2). Inflection is not on that
  spectrum: it is a closed relation between two spellings of one word, so it is recognised
  rather than estimated.

  **What the gate costs**, all falling through to `added` + `removed`:

  - the abbreviation family, including §3.4.6's own original example `UserRepo` ->
    `UsersRepository` — the price of refusing `repo`/`report`
  - an added or dropped token: `UserRepo` and `UserRepoV2` are two classes, not one renamed
  - a changed nesting depth, which is a changed scope rather than a rename

  The evidence that would settle the first is not in the strings — the owner is itself a Symbol,
  so "was this class paired as a rename" is a question a future revision could ask instead of
  guessing.

  Two things this reaches beyond §3.4.6:

  - **§3.4.3's threshold table is not per-kind.** The section was headed "per-symbol-kind
    thresholds" and its pseudocode took a `kind` parameter neither it nor the code ever read;
    §3.4.6 then quoted "for kind=method the threshold is 0.85" for a two-token name the table
    gives 0.95. Kind already does what it can in §3.4.0's bucket key. The parameter is gone.
  - **The one-token admissibility rule now reads both sides.** It read the head alone on the
    arithmetic that a short name anywhere capped the score at 0.75, under the lowest threshold.
    That held while the name axis read the whole qualified name. With the owner gated and the
    axis on the last segment it does not: `Main.main` is one deduped token, it clears the gate
    against `Mains.main` by inflection, and their member names are identical, so the pair scores
    1.0.

  `nameSimilarity` is unchanged and still reads the whole qualified name — stage 3 disambiguates
  within a logic-fingerprint group and has no owner term, so the whole name is the right
  comparison there. The last-segment reading is `memberSimilarity`, new, and used only by §3.4's
  composite. `ownerSimilarity` is replaced by `ownersAreCompatible`.

- 459394f: Pair array-delta elements with their own counterpart, not the first key hit

  §5.2 pairs `rules`, `calls`, `decorators` and `effects` by an identity key — the first three
  with a ±`lineFuzz` tolerance on the line, `effects` with none at all — so a cosmetic line shift
  is not reported as a change. A key does not identify one element,
  though — a Symbol routinely holds two `guard` rules, two calls to one target, two `@Get` — and
  which base element a head element took was decided by base array order.

  Deleting the first of two guards two lines apart:

  ```
  base  guard@1 "!user"   guard@3 "!invoice"
  head                    guard@3 "!invoice"
  ```

  ```json
  "rules": {
    "added": [],
    "removed":  [ { "type": "guard", "line": 3, "condition": "!invoice" } ],
    "modified": [ { "type": "guard", "line": 3, "condition": "!invoice" } ]
  }
  ```

  The surviving guard claimed `guard@1` — the first key hit inside the window — so an untouched
  element was reported as `removed` and `modified` at once, under contradictory buckets, and the
  guard actually deleted appeared nowhere. The same shape reproduced for `calls` and
  `decorators`.

  Pairing now runs in two passes — elements whose key **and content** agree, then whatever is
  left — and each pass chooses a _set_ of pairings rather than one at a time: the largest set
  that does not cross, and among those the one moving the fewest lines. An untouched element is
  claimed by its own counterpart before an edited or deleted neighbour can take it, and what
  remains pairs by proximity, where a genuine edit lands.

  Every part earns its place:

  | base                                    | head                           | first key hit                       | nearest line, greedy         | this rule       |
  | --------------------------------------- | ------------------------------ | ----------------------------------- | ---------------------------- | --------------- |
  | `guard@1 "!user"`, `guard@3 "!invoice"` | `guard@3 "!invoice"`           | removed **and** modified `!invoice` | removed `!user`              | removed `!user` |
  | `guard@1 "!a"`, `guard@2 "!b"`          | `guard@2 "!a"`, `guard@3 "!b"` | nothing                             | modified `!a`, modified `!b` | nothing         |
  | `guard@1 "!a"`, `guard@2 "!a"`          | `guard@3 "!a"`, `guard@4 "!a"` | nothing                             | added `!a`, removed `!a`     | nothing         |

  Row 2 is two guards shifted down a line with nothing edited — the noise line fuzz exists to
  suppress, which proximity alone reintroduces. Row 3 is the same shift where the guards are also
  identical, so the exact pass cannot separate them either: greedily the first head element is
  nearest the _second_ base element, and claiming it strands the other outside the window. Two
  calls to one target and two copies of one decorator are the ordinary way that arises.

  Non-crossing is licensed by ir-schema §14 #11, which orders these arrays by line: two pairings
  that crossed would have an element move above one it was below, which is a different element
  rather than a shift. It also settles ties, and makes the best set reachable by a suffix
  recurrence rather than a general assignment.

  The result depends on array order and cannot not — it pairs by line, and #11 is what fixes that
  order. §3.8 achieves order-independence for Symbol pairing because ids give it a total order
  from content; §5.2 has no counterpart, and §3.7 records the distinction.

  **`effects` are affected too.** They pass no line window, so every same-key candidate is
  admissible and only the ranking applies — but the ranking reads `line`, and a propagated entry
  has none. The `line ?? 0` placeholder now reads as "at the top of the Symbol" rather than as a
  neutral value, so a propagated effect prefers the earliest local entry carrying its key. Two
  entries of one key that swapped places now report nothing, where before they reported two
  modifications.

  `docs/design/diff-algorithm.md` gains §5.2.0, which said nothing about elements sharing a key.

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

- 4c16cad: Point every schema id at the documentation domain

  The four JSON Schemas identified themselves as `https://aburi.dev/schema/...`, a host this
  project does not own and never served them from. The docs site is `aburi.kage1020.com`, so
  that is the name the `$id`s, the `$schema` `const`s, the `$schema` an `aburi init` writes,
  and the plugin manifests now carry.

  The documentation site now serves the four schemas under `/schema/`, so each `$id` resolves
  to the document it names and an editor reading a `$schema` line gets completion and
  validation from it. A build-time check refuses to publish a schema whose `$id` disagrees with
  the URL it is served at.

  `$schema` is validated with a `const`, so an `aburi.json` or a plugin manifest still naming
  the old host is rejected until the string is updated — a find-and-replace of
  `aburi.dev/schema` with `aburi.kage1020.com/schema`, or a re-run of `aburi init --force`.

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

- 37715cd: Stop reporting a lost file's dependency edges as deletions

  `SymbolChange.status: "unknown"` stopped `aburi diff` reporting a withdrawn file's Symbols as
  deleted API. `dependencies[]` had the identical defect and was untouched by it.

  `IR.dependencies` is projected from the resolved call graph, so a Symbol that never reached a
  document takes every edge it participated in with it. `diffDependencies` compared the two arrays
  by `(from, to, via)` and reported whatever the head lacked as removed:

  ```
  base                       → gone.ts#gone → kept.ts#kept, kept.ts#kept → gone.ts#gone
  head, src/gone.ts withdrawn → (neither edge)

  summary.removed:     0     ← correct since stats.skippedFiles landed
  summary.depsRemoved: 2     ← two dependencies nobody deleted
  ```

  The second edge is the half that is easiest to miss. `kept` is in both documents, so the edge
  reads as a call the author removed; it disappeared because the _callee's_ file was never read.

  An edge one document holds is now `unknown` when the other never analysed the file an endpoint
  lives in, carrying `absentFrom` on the same reading as the Symbol side and `lostFiles[]` naming
  the files with the reason each was skipped.

  **Where it differs from the Symbol side, and why**

  - **The endpoint's file comes from the document that holds the edge**, read out of
    `symbols[].source.file` rather than out of the id's path segment. That is the same space
    `stats.skippedFiles[].path` is in and the same space Symbols are classified by, so a Symbol
    reported `unknown` and the edges it took with it cannot disagree about which file went
    missing. Parsing the id would have been a second answer to the same question, and nothing in
    the schema forces the two to agree.
  - **`lostFiles` is a list where `SymbolUnknown` carries one `reason`.** An edge has two
    endpoints: they can sit in two files skipped for two different reasons, one saying re-run and
    the other saying fix something. An intra-file edge collapses to the single file it lost.
  - **Component-level edges are never reclassified.** A Component is an aggregate over roots and
    has no file to lose, so a component endpoint is simply absent from the lookup — no special
    case, and now stated in `docs/design/diff-algorithm.md` §6.2.1 rather than left to be
    rediscovered as an asymmetry.

  A direction or effect flip stays an added + removed pair, with no loss check. Not because
  neither document lost an endpoint file — nothing forbids a path from being both a `source.file`
  and a skipped one — but because both documents _hold_ the edge, so neither is silent about it,
  and `unknown` explains silences.

  `dependencies.unknown[]` and `summary.depsUnknown` are schema-optional only so a diff written
  before they existed stays valid. A current writer always emits both, empty array and zero
  included — unlike the IR's `stats.skippedFiles`, no arithmetic elsewhere in the document would
  let a reader tell "nothing was unknown" from "this writer could not say".

  `diff.md` gains an `### Unknown — the other revision never read one end` group under Dependency
  changes, each line naming the file and the reason. It is not split by level the way the added and
  removed groups are, because only a Symbol endpoint has a file to lose.

  **Not in scope.** `--fail-on` has no dependency token — none exists for `depsAdded` or
  `depsRemoved` either — so the harm here was to `diff.json` consumers and to the Dependency
  changes section, not to the CLI gate. Adding a dependency gate family is its own decision. And a
  file **both** revisions skipped still produces nothing: neither document holds an edge from it,
  so there is no leftover to classify, which is the deps-side face of a gap `aburi diff` reports on
  stderr and the artifact does not.

  `diffDependencies`' new `sides` parameter is **required**. Optional, it would have restored the
  defect silently: a two-argument call classifies every edge into a lost file as a deletion again
  while still writing `unknown: []`, which this schema defines as "nothing was unknown" rather than
  "nobody looked". A caller with no skip list says so by passing a side view whose `lostFiles` is
  empty. `dependencySideView(ir)` is exported to build one, and is the single construction site —
  `buildDiff` feeds the same object to its own Symbol classification, so the two cannot drift.

  For a direct caller the classification of any edge is unchanged when the side views carry no
  losses; the returned object gains an always-present `unknown` array it did not have before, which
  a deep-equal or a snapshot will see.

  Verification: 18 tests in `packages/diff/test/unknown-dependencies.test.ts`, four ajv instance
  tests, a canonical byte-stability case that reverses the input order, and four projection tests.
  Two of the diff tests exist because the rest of the file could not see the difference between
  resolving an endpoint through `source.file` and parsing its id: every other fixture has the two
  equal by construction, so they use a Symbol whose id says `src/old.ts` and whose `source.file`
  says `src/actual.ts`, in both directions.

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

- e7b886e: Index stage 4's buckets by member token, so a bulk rename is not a cross-product

  §3.4.0 partitions the base Symbols by `(kind, signatureNullness)` and calls the result
  near-linear on the grounds that a bucket holds "a few dozen". A directory rename with no git
  rename information — the §9.4 plugin-difference and §11.5 shallow-clone situations — puts every
  method of the codebase in one bucket, so stage 4 scored the whole cross-product: 64 s at 4000
  symbols against §8.3's 2 s target when that was measured, and 14 s today, after a per-pass
  token memo and one-sweep candidate settling took most of the per-comparison cost out.

  Within a bucket the bases are now indexed by the tokens of their **member** names, and a head
  is offered only the bases sharing one. That costs no recall, and the reason is arithmetic: the
  composite is `0.5 * member + 0.3 * signature + 0.2`, the table's lowest row is 0.85, and the
  signature axis is worth at most 0.3 — so `member >= 0.7` for any pairing that survives. A
  Jaccard that high is above zero, and a Jaccard above zero is a shared token.

  Two details the rule needs. A member name with **no** tokens (`Foo.Bar.`, which §3.4.3 admits
  because its qualified name has two) is indexed under a key of its own, or it would be
  unreachable — a pairing lost to the index rather than to the score. And a head whose postings
  add up to the whole bucket is walked over the bucket directly, since a base is reached once per
  shared token: every Symbol named `handleRequest` puts the entire bucket under both of its
  tokens, and without the fallback the index would cost more than it saves.

  Reading §3.4.3's member floor **before** §3.4.6's gate matters as much as the index on a corpus
  of varied names: the floor is one Jaccard over token sets the pass already holds, where the
  gate splits both owners into segments, tokenises each and runs an augmenting-path matching. It
  is the only early exit — the gate short-circuits internally on identical owners and on first
  segments that cannot correspond, and hoisting either out buys nothing, since the gate reaches
  them on the same two lookups. Neither order dominates: the reverse suits a corpus of identical
  member names and differing owners, where the gate is what refuses.

  Measured on a directory rename with an edited body, no git rename information, everything in
  one bucket (median of five, 4000 symbols):

  |                             | before | after  |
  | --------------------------- | ------ | ------ |
  | varied names                | 14.0 s | 1.3 s  |
  | every member name identical | 13.4 s | 13.5 s |

  The second row is the shape no index helps with — one token, carried by everything — and the
  fallback is what keeps it from getting worse. The first is inside §8.3's target.

  These are wall-clock on a loaded developer machine and the spread is wide: repeated runs of one
  build ranged 0.9-2.3 s on the first row. The order of magnitude is the claim; a single run is
  not.

  An earlier attempt memoised the gate on the owner pair, which is unbounded: a bulk rename
  produces as many distinct owner pairs as candidates, and 4000 symbols exceeded V8's `Map` limit
  outright. What ships instead keys its memos on single names, so they grow with the number of
  distinct names rather than with the cross-product — which is the property that makes them safe,
  rather than any claim to be allocation-free.

- Updated dependencies [5c36d16]
- Updated dependencies [e2dab93]
- Updated dependencies [309f093]
- Updated dependencies [74aa475]
- Updated dependencies [fc8f3c9]
- Updated dependencies [630460f]
- Updated dependencies [f73eb46]
- Updated dependencies [4c2d5aa]
- Updated dependencies [060d7a5]
- Updated dependencies [74aa475]
- Updated dependencies [1e59445]
- Updated dependencies [c825c74]
- Updated dependencies [8ce6ed4]
- Updated dependencies [4c16cad]
- Updated dependencies [6d3d390]
- Updated dependencies [c3654c3]
- Updated dependencies [0b39623]
- Updated dependencies [da20510]
- Updated dependencies [baa6857]
- Updated dependencies [b8763eb]
- Updated dependencies [cafd4b8]
- Updated dependencies [667f9b7]
- Updated dependencies [54881d5]
- Updated dependencies [37715cd]
- Updated dependencies [dbdc8aa]
- Updated dependencies [836b05a]
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
