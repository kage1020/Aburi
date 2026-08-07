# Diff Algorithm

Definition of the `aburi diff` algorithm, which compares two IRs (base / head) and produces a semantic diff.

References:
- [`ir-schema.md`](./ir-schema.md) §3 — Symbol ID conventions
- [`fingerprint.md`](./fingerprint.md) — the 3-axis fingerprint
- [`extension-vocab.md`](./extension-vocab.md) — vocab appearing in diff reports

---

## 1. Purpose

The core feature of Aburi's primary use case: "reviewing PRs at semantic granularity".
Instead of a line-based code diff, it reports what was added / removed / moved / changed at the Symbol level.

The reviewer's workflow becomes:
- Scrolling through huge line diffs → eliminated
- Symbols that are "move only" or "implementation refactor only" are collapsed → out of sight
- Focus only on places where the "public contract / business logic / side effects" changed

## 2. Inputs and outputs

### 2.1 Inputs

Two IRs (`aburi.ir.v1`):
- `baseIR`: comparison source
- `headIR`: comparison target

Both must have matching `schema` versions (a mismatch is a fatal error).

### 2.2 Input supply methods

```bash
aburi diff <base>..<head>             # specify git refs (both regenerated)
aburi diff --base ir-base.json --head ir-head.json  # supply existing IRs directly
```

For git refs, Aburi internally:
1. Checks out the base ref and runs `aburi scan` (IR generation)
2. Returns to the head ref (or uses a worktree in the first place)
3. Compares the two IRs

Using a git worktree allows generating the base IR while keeping head intact, so this is the default approach.

### 2.3 Outputs

```bash
out/diff.json     # diff result (aburi.diff.v1.json schema)
out/diff.md       # Markdown projection for pasting into PR comments
```

A one-line summary goes to `stdout`; details are referred to `out/diff.md`.

## 3. Matching algorithm (5 stages)

Pairs up base/head Symbols.

```
input:  baseIR.symbols, headIR.symbols
output: matchedPairs[], remainingBase[], remainingHead[]
```

### 3.1 Stage 1: exact ID match

```
baseById = {s.id: s for s in baseIR.symbols}
headById = {s.id: s for s in headIR.symbols}

for id in keys(baseById) ∩ keys(headById):
  pair = (baseById[id], headById[id])
  matched.push({base: pair[0], head: pair[1], rationale: 'id-match'})
  remove from remainingBase / remainingHead
```

The most common case. Symbols with no file move and no rename are settled here.

### 3.2 Stage 2: git rename detection (only when git is available)

```
if git available and ref-based diff:
  renameMap = git diff --find-renames base..head
              → {oldpath: newpath}
  
  for sym in remainingBase:
    if sym.source.file in renameMap:
      newPath = renameMap[sym.source.file]
      expectedId = sym.id with old path replaced by newPath
      if expectedId in remainingHead:
        pair, rationale: 'git-rename'
        remove from remaining
```

git's rename detection returns a physical-level mapping, making it the most reliable move-detection mechanism.

### 3.3 Stage 3: logic fingerprint match

For cases git rename could not catch, or when git is unavailable.

```
logicMap = group remainingBase by sym.fingerprint.logic (excluding dropped)
         → {logic_hash: [base symbols with same logic]}

for h in remainingHead (excluding dropped):
  candidates = logicMap[h.fingerprint.logic]
  if len(candidates) == 0:
    continue  # fall through to stage 4
  if len(candidates) == 1:
    pair, rationale: 'logic-fingerprint'
    remove from remaining
  else:  # multiple candidates
    best = argmax over candidates of nameSimilarity(c.name, h.name)
    if best.similarity >= 0.85:
      pair, rationale: 'logic-fingerprint+name-disambiguation'
      remove from remaining
    else:
      continue  # fall through to stage 4 (leave all candidates unmatched)
```

Matching logic fingerprint = same meaning. This catches a good share of "file move without rename" and "file move with a minor refactor".

Every head symbol that **could not be paired in stage 3 falls through to stage 4**. Even when stage 3 found a best candidate below the threshold, it is re-evaluated in stage 4 without exception.

Dropped symbols all share the fingerprint `"000000000000"`, so they would collide massively under the same hash. Dropped-to-dropped matching is excluded from stages 3/4 and handled by a dedicated weak matcher (§3.4.5).

### 3.4 Stage 4: name + signature similarity (last resort)

```
# Bucket pre-filter (O(N) hash bucketing) suppresses K^2
buckets = group remainingBase by (kind, signatureNullness)
        → { (kind, sigNull): [base symbols] }

for h in remainingHead:
  bucket = buckets.get((h.kind, h.signature === null))
  if !bucket || bucket.length === 0: continue
  best = null
  for b in bucket:
    score = 0.5 * nameSimilarity(b.name, h.name)
          + 0.3 * signatureSimilarity(b.signature, h.signature)
          + 0.2 * ownerSimilarity(b.name, h.name)         # §3.4.6
    if score > best?.score:
      best = {symbol: b, score}
  threshold = thresholdFor(h)                             # §3.4.3
  if best && best.score >= threshold:
    pair, rationale: 'name-signature'
    remove from remaining and from bucket
```

#### 3.4.0 Bucket pre-filter (mandatory)

Stage 4 implemented as O(K^2) drops below practical speed at K=500 (heavy use of the Repository pattern / Zod schemas).
As a bucket pre-filter, hash-partition by the combination `(kind, signature === null ? 'no-sig' : 'has-sig')` and evaluate each head linearly only within its corresponding bucket.
The effective complexity becomes the square of the per-bucket size of K — typically ≤ a few dozen — so it is near-linear.

#### 3.4.3 Per-symbol-kind thresholds

To avoid false positives on short names (1–2 token names like `getUser` vs `getUsers`), the threshold is adjusted by symbol kind and name token count:

```
thresholdFor(kind, headName):
  tokenCount = tokenize(lastSegment(headName)).length
  if tokenCount <= 1:
    return 1.0                  # 1-token names are never paired in stage 4 (false-positive prevention)
  if tokenCount == 2:
    return 0.95                 # strict (e.g. 'getUser' vs 'getUsers' scores 0.5 → does not pass)
  return 0.85                   # default
```

Additionally, the `signature: null + null` combination (interface/type/class bodies, etc.) makes signatureSimilarity always return 1.0. Symbols with a null signature are **never paired in stage 4** (insufficient information):

```
if h.signature === null && all candidates have signature === null:
  skip pair, leave for added/removed
```

#### 3.4.4 Tuning via configuration

`config.diff.nameSignatureThreshold` (default: `null` = automatic per symbol kind) overriding the global threshold is planned — see the [roadmap](../roadmap.md). Currently the threshold is automatic only.

#### 3.4.5 Stage 4.5: dedicated weak matcher for dropped

Dropped symbols have zero fingerprints and cannot use stages 3/4. To catch dropped symbols that moved in environments without git rename, a lightweight dropped-only matcher runs after stage 4:

```
for h in remainingHead where h.dropped:
  best = null
  for b in remainingBase where b.dropped:
    if b.kind != h.kind: continue
    # trailing segment of the qualified name + file basename
    score = 0.5 * (lastSegment(b.name) === lastSegment(h.name) ? 1 : 0)
          + 0.5 * (basename(b.source.file) === basename(h.source.file) ? 1 : 0)
    if score > best?.score:
      best = {symbol: b, score}
  if best && best.score >= 0.5:  # accept even a one-sided match
    pair, rationale: 'dropped-weak-match'
    remove from remaining
```

As a result, a change such as "only renamed the directory of DTO files" is recorded as `moved:10` rather than `droppedAdded:10 / droppedRemoved:10`.
There is a false-positive risk, but dropped symbols are outside the IR's primary field of view, so the impact is small.

#### 3.4.1 nameSimilarity

Token split (camelCase / snake_case / `.` / `::`) → Jaccard similarity. Levenshtein is too sensitive and was rejected.

```
tokenize("InvoiceService.createInvoice") = ["invoice", "service", "create", "invoice"] (lowercase, dedupe)
jaccard(A, B) = |A ∩ B| / |A ∪ B|
```

#### 3.4.6 ownerSimilarity (R-8: avoiding same-name method collisions)

If similarity were computed on `shortName` (last segment) alone, a method whose class was renamed (`UserRepo.getUser` → `UsersRepository.getUser`) could be mis-paired with a same-named method of a different class (`AdminRepo.getUser`).
To prevent this, an **owner-segment similarity** is added to the score formula with weight 0.2:

```
ownerOf(qname):
  byColon = qname.split('::')[0..-2]               # the Class:: portion of a static method
  byDot   = qname.split('.')[0..-2]                # the nested.namespace.Class portion
  return all but last segment, joined back
  # 'Class::method' → 'Class'
  # 'A.B.C.method'  → 'A.B.C'
  # 'topLevel'      → ''   (empty)

ownerSimilarity(baseName, headName):
  baseOwner = ownerOf(baseName)
  headOwner = ownerOf(headName)
  if baseOwner === '' && headOwner === '': return 1.0   # top-level functions
  if baseOwner === '' || headOwner === '': return 0.0
  return jaccardTokens(baseOwner, headOwner)
```

As a result:
- `UserRepo.getUser` vs `AdminRepo.getUser` → name=1.0, sig=1.0, owner=jaccard("UserRepo", "AdminRepo")≈0.33 → total 0.5+0.3+0.066=0.866 (for kind=method the threshold is 0.85, barely passes — an edge case that only occurs when stage 1 has already consumed UserRepo.getUser)
- `UserRepo.getUser` vs `UsersRepository.getUser` (class rename) → owner=jaccard("UserRepo", "UsersRepository")≈0.5 → total 0.5+0.3+0.1=0.9 → passes (as intended)
- `UserRepo.findById` vs `UsersRepository.findById` (class rename, method kept) → total 0.9 → passes

#### 3.4.2 signatureSimilarity

null + null → 1.0
null + non-null or the reverse → 0.0
Both non-null →
- match ratio of input types (order-sensitive)
- match ratio of output types
- set match ratio of throws (order-insensitive)
averaged.

### 3.5 Stage 5: the remainder is added / removed

Symbols not paired by this point are finalized:

- `remainingHead` → status: `added`
- `remainingBase` → status: `removed`

### 3.6 Handling dropped symbols

Symbols with `dropped: true` are **excluded** from matching in stages 3/4:

- Their fingerprints are all zero, so they collide 100% in stage 3
- Judging identity by name+signature alone carries too little information

Instead, the dropped-only weak matcher of stage 4.5 (§3.4.5) runs:

1. If caught by stage 1 (exact ID match), settled
2. Otherwise stage 4.5 attempts the `lastSegment(name) + basename(file)` weak match
3. If still unmatched, counted independently as "dropped disappeared/appeared" (aggregated in the "dropped + changes" section of the diff report)

Dropped symbols are outside the IR's primary field of view, so the false-positive risk of stage 4.5 is accepted.

### 3.7 Identity collisions (fail-fast)

The diff keys three collections by identity and reads each key once per entry: the five stages pair Symbols by `id` (§3.1), §6.1 maps Components by `id`, §6.2 maps Dependencies by the `(from, to, via)` triple. Repeat any of them and the diff still produces an answer — with an entry left out, an entry classified twice, or a change the two revisions do not contain — and nothing downstream can tell that answer from the real one. ir-schema §14 #1, #2 and #13 forbid all three for that reason.

**At extraction time**, the Aburi core stops with a fatal error on:

- Multiple Symbols generated with the same ID (e.g., multiple `export default function` in the same file, or CJS `module.exports.default` coexisting with ESM `export default`)
- Two or more `<default>` symbols detected within the same file
- A dropped and a non-dropped symbol colliding on the same ID

The error message is `Symbol ID collision at <file>: <id>`, prompting the user to fix the offending location.

**At the diff entry point**, `buildDiff` checks the same three identities again before the first stage runs, because it is public API: an IR read off disk has been through the integrity checker, but one a caller assembled in memory has been through nothing. The check is scoped to identity rather than delegating to the full integrity checker, whose remaining rules — array ordering, effect vocabulary, Unicode normalisation — a caller can break without changing the diff's answer. A collision raises `DiffError` with code `ir-identity-collision`, naming the side, the collection, the repeated value, and both positions.

## 4. Status determination

For each matched pair:

```
droppedToggled = base.dropped != head.dropped     // §4.1
pathChanged    = base.source.file != head.source.file
apiChanged     = base.fingerprint.api    != head.fingerprint.api
logicChanged   = base.fingerprint.logic  != head.fingerprint.logic
syntaxChanged  = base.fingerprint.syntax != head.fingerprint.syntax

fingerprintChanged = apiChanged || logicChanged || syntaxChanged

if droppedToggled:
  status = "dropped-toggled"                       // takes precedence over all others
elif pathChanged && fingerprintChanged:
  status = "moved+changed"
elif pathChanged:
  status = "moved"
elif fingerprintChanged:
  status = "changed"
else:
  status = "unchanged"
```

unchanged is not included in the default output (only counted in the summary).

### 4.1 Why the `dropped-toggled` status exists

The transition `dropped: false → true` (kept → dropped) or `dropped: true → false` (dropped → kept) is **caused by changes to drop rules or plugin configuration**:

- Adding a stronger DTO-detection rule → many classes become `dropped: true` at once
- Adding a framework plugin turns previously dropped symbols (no decorators) into boundaries → `dropped: false`

In this case the fingerprints inevitably all change (`a..b` → `0..0` or the reverse).
Treating this as `changed` produces the classic false report: **"a DTO rule change alone lists every DTO as api-changed in the API changes section (the highest-severity section)"**.

Treating `dropped-toggled` as an independent status means:

- delta (`apiChanged`, etc.) is **not computed** (always treated as false)
- The Markdown projection stores these in a dedicated collapsed section, "Drop rule changes"
- `--fail-on dropped-toggled` can make it an explicit CI gate

## 5. Delta computation (changed / moved+changed only)

Compute per-field "what" changed:

### 5.1 Fingerprint axes

```
delta.apiChanged    = base.fp.api    != head.fp.api
delta.logicChanged  = base.fp.logic  != head.fp.logic
delta.syntaxChanged = base.fp.syntax != head.fp.syntax
```

If all three axes changed: "implementation, contract, and meaning all changed".

### 5.2 Array diff (rules / effects / calls / decorators)

For each array, **three kinds of delta** are computed:

- `added[]`: elements in head but not in base
- `removed[]`: elements in base but not in head
- `modified[]`: elements present in both but with differing content (e.g., a rule where only `condition` changed)

Element identity criteria:
- Rule: identified by `(type, line)` (line fuzzed with a tolerance of ±2, §5.2.1)
- Effect: identified by `(id, target)`
- Call: `(target, line)` (line fuzz)
- Decorator: identified by `(name)`

##### 5.2.1 Rationale for line fuzz

Line numbers shift slightly under manual edits, so treating rules with the same `(type, condition)` as the same rule makes the delta more readable. By default a difference of up to ±2 lines is tolerated; beyond that they are treated as distinct rules.

Adjustable via `config.diff.lineFuzz` (default: `2`, `0` disables fuzz, maximum `10`). Projects that shift 5 lines due to sweeping prettier config changes can raise it to `5`, etc.

However, fingerprints themselves contain no line information (D4 §4), so line fuzz is **for delta display only**. It does not affect fingerprint equality checks.

##### 5.2.2 Handling of arguments in Decorator deltas

Decorators are identified by `(name)`, but differences in `arguments` are shown in the delta:

```
Decorator delta (modified):
- @Post: arguments '/invoices' → '/invoices/v2'
- @UseGuards: arguments AuthGuard → AuthGuard,RoleGuard
```

`raw` is combined with line fuzz for the modified determination:
- Same name + within line fuzz + differing arguments → modified
- Same name + same arguments + only line differs → implicitly the same (not shown in the delta)

##### 5.2.3 `modified` determination for Component diffs

Components have no `modified` (only the three states added / removed / changed).
Inside `changed`, delta fields indicate the differences via the booleans `rootsChanged` / `publicApiChanged` / `frameworksChanged`. For each field that actually changed, the **full before/after arrays are emitted** (no per-element modified diff — output is field-granular):
```
Component changed: billing
  roots: ['apps/billing'] → ['apps/billing', 'packages/billing-domain']
  frameworks: [] → ['nestjs']
```

### 5.3 signature delta

```
delta.signature = {
  inputs: { added: [...], removed: [...], modified: [...] },
  outputs: { added: [...], removed: [...] },
  throws:  { added: [...], removed: [...] },
  asyncChanged: bool,
  generatorChanged: bool,
  typeParametersChanged: bool
}
```

If both signatures are null → delta.signature = null.

### 5.4 component / visibility delta

```
delta.componentChanged = base.component != head.component
delta.visibilityChanged = base.visibility != head.visibility
```

A Component change means "responsibility relocation", so the diff report emphasizes it.

## 6. Component / Dependency diff

Not only Symbols but also Components / Dependencies are diffed, in separate arrays.

### 6.1 Component diff

```
componentDiff = {
  added:   [Component],         // head only
  removed: [Component],         // base only
  changed: [{
    before: Component,
    after:  Component,
    delta: { rootsChanged, publicApiChanged, frameworksChanged }
  }]
}
```

### 6.2 Dependency diff

```
dependencyDiff = {
  added:   [Dependency],
  removed: [Dependency]
}
```

Dependency identity is judged by (from, to, via). Changes to direction / effect are treated as an added+removed pair (no modified needed).

## 7. Output formats

### 7.1 Diff result JSON (`out/diff.json`)

```jsonc
{
  "$schema": "https://aburi.dev/schema/aburi.diff.v1.json",
  "generator": { "name": "aburi", "version": "1.0.0" },
  "base": {
    "ref": "main",                                   // git ref or "ir-base.json"
    "irSchema": "aburi.ir.v1.json"
  },
  "head": {
    "ref": "HEAD",
    "irSchema": "aburi.ir.v1.json"
  },
  "summary": {
    "added":           5,
    "removed":         3,
    "moved":           2,
    "movedChanged":    1,
    "changed":         12,
    "droppedToggled":  4,
    "unchanged":       142,
    "droppedAdded":    4,
    "droppedRemoved":  1,
    "componentsAdded":   1,
    "componentsRemoved": 0,
    "componentsChanged": 2,
    "depsAdded":     3,
    "depsRemoved":   1
  },
  "symbols": [
    { "status": "added",   "symbol": { /* Symbol */ } },
    { "status": "removed", "symbol": { /* Symbol */ } },
    { "status": "moved",   "before": {...}, "after": {...}, "rationale": "git-rename" },
    { "status": "changed", "before": {...}, "after": {...}, "delta": { /* see §5 */ } },
    { "status": "moved+changed", "before": {...}, "after": {...}, "rationale": "...", "delta": {...} },
    { "status": "dropped-toggled", "before": {...}, "after": {...}, "direction": "to-dropped" | "to-kept" }
  ],
  "components": {
    "added":   [ /* Component[] */ ],
    "removed": [ /* Component[] */ ],
    "changed": [ /* {before, after, delta} */ ]
  },
  "dependencies": {
    "added":   [ /* Dependency[] */ ],
    "removed": [ /* Dependency[] */ ]
  }
}
```

`status: "unchanged"` is not included in the output (counted in the summary only).

### 7.2 Markdown projection (`out/diff.md`)

A format intended for pasting into PR comments:

```md
# Aburi diff: main..HEAD

**Summary**: +5 added, -3 removed, ~12 changed, 2 moved, 1 moved+changed

## ⚠ API changes (review required)

### `InvoiceService.createInvoice` *(method)*
- **signature**: outputs `Promise<Invoice>` → `Promise<InvoiceWithReceipt>`
- decorator added: `@UseGuards(AuthGuard)`

## 🔧 Logic changes

### `RolesGuard.canActivate` *(method)*
- **effects added**:
  - `db.write: prisma.audit.create` (L75)
- **rules added**:
  - guard: `!user.verified` (L42)

## ➕ Added (5)

### `InvoiceService.refund` *(method)*
- boundary: `@Post('/refund')`
- effects: `db.write`, `event.publish`
- rules: guard, throw

## ➖ Removed (3)

### `ObsoleteController.endpoint` *(method)*
- was: `@Get('/old')`

## 🔀 Moved (no semantic change)

<details>
<summary>2 items (collapsed)</summary>

- `apps/billing/old.ts#X` → `apps/billing/new.ts#X` (git rename)
- `packages/util/a.ts#Y` → `packages/util/b.ts#Y` (logic fingerprint match)
</details>

## 🧱 Component changes

### added: `payments`
- roots: `apps/payments`
- public API: `apps/payments/src/routes/**`

## 🔗 Dependency changes

### added
- `billing` → `payments` (via: import)
```

Section order is **high importance → low**:

1. API changes (warning)
2. Logic changes
3. Added (new)
4. Removed (deleted)
5. Moved+Changed (moved and changed)
6. Moved (no semantic change — collapsed)
7. Component changes
8. Dependency changes
9. Dropped changes (collapsed)
10. Syntax-only changes (collapsed)

Collapsed sections are visible at **zero review cost**.

## 8. Performance characteristics

### 8.1 Complexity

| Stage | Complexity |
|---|---|
| Stage 1 (ID match) | O(N) hash map lookup |
| Stage 2 (git rename) | O(R) where R = renamed files |
| Stage 3 (logic fingerprint) | O(N) hash map lookup |
| Stage 4 (name+signature) | O(K^2) where K = remaining unmatched |

K is usually < 100 (most symbols are settled in stage 1). Effectively O(N), i.e. linear.

### 8.2 Memory

Both base and head Symbols are held in memory. Under 100MB for a medium monorepo (10k Symbols).
Large repositories (>100k) would require streaming, which is not yet supported.

### 8.3 Targets

For a medium monorepo (~1000 files, ~5000 Symbols): **diff computation <2 seconds** (excluding IR generation).
Including IR generation: <30 seconds (including a full Workspace scan).

## 9. Edge cases

### 9.1 Schema version mismatch

base.$schema != head.$schema → fatal error.
When a future v2 ships, an upgrader will be provided.

### 9.2 Empty base / empty head

- Empty base → every head Symbol is added
- Empty head → every base Symbol is removed
- Both empty → empty diff

### 9.3 Component id collision

If base/head share the same Component id but with different roots:
- Recorded as componentDiff.changed with delta.rootsChanged = true
- If a Symbol moved to the new component, it is recorded with componentChanged = true

### 9.4 Differing plugin configurations

If base has the effects-prisma plugin enabled and head does not:
- What was db.write in base remains as calls in head
- The Symbol's logic fingerprint changes, so it appears as "changed"
- There is no mechanism to tell directly from the Diff that the cause is a plugin configuration difference (a planned proposal records `generator.plugins[]` in the IR — see the [roadmap](../roadmap.md))

### 9.5 Massive moved counts

When a directory rename turns every symbol into moved:
- Aggregated in the summary (`moved: 1234`)
- The Markdown displays them grouped as "inferred directory rename" (future feature; individual listing is acceptable today)

### 9.6 Failed dropped-to-dropped matches

Dropped symbols are tried in the order stage 1 (exact ID match) → stage 4.5 (weak matcher, §3.4.5).
If they survive with the same ID they are treated as unchanged; if caught by stage 4.5 they become `moved` (rationale: `dropped-weak-match`); otherwise they are counted independently as droppedRemoved.

## 10. Verifiable properties

| ID | Input | Expected |
|---|---|---|
| DF1 | Feed the same IR as base/head | summary all 0, changes/components/dependencies all empty |
| DF2 | 1 new Symbol in head | added: 1, 1 entry in the Markdown Added section |
| DF3 | 1 Symbol deleted from base | removed: 1 |
| DF4 | Only a rule's condition changed | changed: 1, delta.logicChanged: true, delta.apiChanged: false |
| DF5 | signature outputs changed | changed: 1, delta.apiChanged: true |
| DF6 | File rename (git rename detectable) | moved: 1, rationale: "git-rename" |
| DF7 | File rename + rule added | moved+changed: 1, rationale: "git-rename" |
| DF8 | File rename (no git) with matching logic fp | moved: 1, rationale: "logic-fingerprint" |
| DF9 | Method rename (same file, same logic) | moved: 1, rationale: "name-signature" (same logic fp but different ID) |
| DF10 | Multiple Symbols in base/head share the same logic fp | Disambiguated by name similarity, paired correctly |
| DF11 | Component added | 1 entry in components.added |
| DF12 | Dependency added | 1 entry in dependencies.added |
| DF13 | Dropped Symbol paired (same ID) | Treated as unchanged |
| DF14 | Dropped Symbol disappeared (basename also changed) | Counted in droppedRemoved |
| DF14b | Dropped Symbol moved to another directory (same basename) | moved: 1, rationale: "dropped-weak-match" |
| DF15 | Schema version mismatch | fatal error |
| DF16 | Same rule differing only in line (within ±2) | no delta.rules.modified (line fuzz) |
| DF17 | Same-condition rule with a large line difference (>2) | delta as added + removed |
| DF18 | Only syntax changed (logic/api unchanged) | changed, only delta.syntaxChanged true → in Markdown: "syntax-only, collapsed" |

## 10.1 Diff schema compatibility policy

The compatibility policy of `aburi.diff.v1.json` matches the IR schema (ir-schema.md §15).
In particular, because the CI gate (`aburi diff --fail-on`) depends on it:

- Adding a `MatchRationale` enum value is **breaking** (consumers' `--fail-on` settings depend on fixed values)
- Adding a status enum value (`added` / `removed` / `changed` / `moved` / `moved+changed` / `dropped-toggled`) is **breaking**
- Adding a `summary` field is non-breaking

## 11. Design decisions

### 11.1 Why a 5-stage matching pipeline

A single mechanism (ID match only) produces massive false add/remove on file renames, method renames, and refactors.
Applying multiple mechanisms sequentially, settling from the most trustworthy stage down, raises precision:

1. ID match (definitive information)
2. git rename (physically definitive)
3. logic fingerprint match (semantic identity)
4. name + signature similarity (heuristic)

The stage-4 threshold of 0.85 is provisional; it will be tuned on real projects.

### 11.2 Why dropped is excluded from stage 3

Dropped symbols with `fingerprint.logic = "000000000000"` would "match" each other in bulk, producing meaningless pairs.
Dropped symbols are settled first by stage 1 (exact ID match); the remainder is picked up cheaply by the dedicated weak matcher of stage 4.5 (`lastSegment + basename`, §3.4.5).
Stage 4.5 runs with the false-positive risk priced in, under the premise that "dropped is outside the IR's primary field of view, so the impact is small".

### 11.3 Why line fuzz (±2) is used only for delta display

Including line numbers in fingerprint computation would change every logic FP the moment a single blank line is inserted. Fingerprints are kept line-free ([`fingerprint.md`](./fingerprint.md) §4).
However, listing rules that differ only in line as distinct items hurts delta readability. The ±2 tolerance applies at display time only.

### 11.4 Why unchanged is excluded from the output

Emitting every unchanged Symbol would make the diff as large as the IR itself and impractical. Only a count is provided in the summary; for details, refer to the IR itself.

### 11.5 Why git is not required

In CI environments, git history can be shallow (`shallow clone`), so git rename detection is not always available. Making the fingerprint-based fallback (stage 3) mandatory keeps the diff working without git.

### 11.6 Purpose of collapsed Markdown sections

Symbols that are "move only" or "syntax only" need not be seen by reviewers. Collapsing them keeps PR comments readable while preserving all information. GitHub's `<details>` element is collapsed by default.

### 11.7 Why component / dependency diffs are separated from the Symbol diff

Component / Dependency changes are architecture-level changes. Mixing them with Symbol additions/removals hurts clarity. They are managed in separate top-level fields and given separate sections in the Markdown as well.

### 11.8 Why plugin-configuration-difference detection is not yet supported

If base and head have different plugin sets, the same source yields different IRs. This is a difference in "observation", not "meaning".
The diff currently works under the premise of "trusting the IR"; plugin differences will be handled by a separate mechanism (recording `generator.plugins[]` in the IR). Introducing this today would require a schema change, so it is deferred — see the [roadmap](../roadmap.md).
