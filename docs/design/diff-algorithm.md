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
  
  claimants = {}
  for sym in remainingBase:
    if sym.source.file not in renameMap: continue
    expectedId = sym.id with old path replaced by renameMap[sym.source.file]
    if expectedId in remainingHead:
      claimants[expectedId].append(sym)

  for (headId, bases) in claimants:
    pair the lowest base.id with headId, rationale: 'git-rename'
    remove from remaining
```

git's rename detection returns a physical-level mapping, making it the most reliable move-detection mechanism.

Two base files renamed onto one target predict the same head id, so the claimants are collected before one is chosen and the lowest `base.id` is the move source. §3.8 does not apply — there is no score to order by — but the reason for fixing the choice is the one it gives.

### 3.3 Stage 3: logic fingerprint match

For cases git rename could not catch, or when git is unavailable.

```
group both sides by sym.fingerprint.logic (excluding dropped)
  → a group is {bases, heads} that can only pair with each other

for each group:
  while bases and heads remain:
    if len(bases) == 1:
      # identical logic is proof enough on its own; no similarity test
      pair with the head of highest nameSimilarity, ties to the lower head id
      rationale: 'logic-fingerprint'
      break
    candidates = [(b, h, nameSimilarity(b.name, h.name))
                  for b in bases for h in heads
                  if nameSimilarity >= 0.85]
    accepted = acceptInScoreOrder(candidates)     # §3.8
    if accepted is empty:
      break   # fall through to stage 4 with the group intact
    pair each, rationale: 'logic-fingerprint+name-disambiguation'
    remove them and repeat — a round that leaves one base makes it the lone candidate above
```

Matching logic fingerprint = same meaning. This catches a good share of "file move without rename" and "file move with a minor refactor".

Every head symbol that **could not be paired in stage 3 falls through to stage 4**. Even when stage 3 found a best candidate below the threshold, it is re-evaluated in stage 4 without exception.

Dropped symbols all share the fingerprint `"000000000000"`, so they would collide massively under the same hash. Dropped-to-dropped matching is excluded from stages 3/4 and handled by a dedicated weak matcher (§3.4.5).

### 3.4 Stage 4: name + signature similarity (last resort)

```
# Bucket pre-filter (O(N) hash bucketing) suppresses K^2
buckets = group remainingBase by (kind, signatureNullness)
        → { (kind, sigNull): [base symbols] }
        skipping any base with tokenize(b.name).length <= 1     # §3.4.3, inadmissible

candidates = []
for h in remainingHead:
  if h.signature === null: continue                       # §3.4.3, inadmissible
  if tokenize(h.name).length <= 1: continue               # §3.4.3, inadmissible
  bucket = buckets.get((h.kind, 'has-sig'))
  if !bucket: continue
  threshold = thresholdFor(h.name)                        # §3.4.3
  for b in bucket:
    if not ownersAreCompatible(b.name, h.name): continue  # §3.4.6, the owner gate
    score = 0.5 * memberSimilarity(b.name, h.name)        # §3.4.1, the last segment
          + 0.3 * signatureSimilarity(b.signature, h.signature)
          + 0.2 * 1.0                                     # §3.4.6, satisfied by the gate
    if score >= threshold:
      candidates.append((b, h, score))

for (b, h, score) in acceptInScoreOrder(candidates):      # §3.8
  pair, rationale: 'name-signature'
```

#### 3.4.0 Bucket pre-filter (mandatory)

Stage 4 implemented as O(K^2) drops below practical speed at K=500 (heavy use of the Repository pattern / Zod schemas).
As a bucket pre-filter, hash-partition by the combination `(kind, signature === null ? 'no-sig' : 'has-sig')` and evaluate each head only within its corresponding bucket.

**That key alone is not a partition of anything.** A directory rename with no git rename information — the §9.4 plugin-difference and §11.5 shallow-clone situations — leaves every method of the codebase in one bucket, so "a few dozen per bucket" describes the easy case rather than the hard one. Measured at 4000 symbols in one bucket, stage 4 took 64 s against §8.3's 2 s target.

So within a bucket the bases are indexed by the tokens of their **member** names, and a head is offered only the bases sharing one:

```
for each base in the bucket:
  for each token of tokenize(lastSegment(base.name)):
    index[token].append(base)

for each head:
  candidates = the union of index[token] for the head's member tokens
```

**This costs no recall.** The composite is `0.5 * member + 0.3 * signature + 0.2`, the lowest row of §3.4.3's table is 0.85, and the signature axis is worth at most 0.3 — so `member >= 0.7` for any pairing that survives, whichever row applies. A Jaccard that high is a Jaccard above zero, and a Jaccard above zero is a shared token. Nothing outside the union could have paired.

Two details the rule needs:

- **A member name with no tokens** is indexed under a key of its own. `Foo.Bar.` has an empty last segment and two tokens in its qualified name, so §3.4.3 admits it, and two such Symbols score 1.0 on an axis comparing two empty sets. Without a key they would be unreachable — a pairing lost to the index rather than to the score.
- **A head whose postings cover the bucket** is walked over the bucket directly. A base is reached once per token it shares, so a head whose postings add up to at least the whole bucket pays for the index instead of saving on it: every Symbol named `handleRequest` puts the entire bucket under both of its tokens. Falling back keeps the index a strict improvement rather than a trade.

The order the three tests run in matters as much as the index, because either of the first two can be the selective one:

1. `sameOwner` — a string compare, and true for every method of one class
2. the member floor above — one Jaccard over token sets the pass already holds
3. §3.4.6's gate — splits both owners into segments, tokenises each, runs an augmenting-path matching

Reading them cheapest-first is worth more than the index on a corpus where the members agree and the owners do not. The gate also answers early where it can: identical owners, and owners whose *first* segments cannot correspond, are settled without the matching.

Measured on a directory rename with an edited body, no git rename information, everything in one bucket:

| | before | after |
|---|---|---|
| 4000 symbols, varied names | 14.0 s | 1.3 s |
| 4000 symbols, every member name identical | 13.4 s | 13.5 s |

The second row is the shape the index cannot help with — one token, shared by everything — and the point of the fallback is that it does not make it worse.

#### 3.4.3 Thresholds by name token count

To avoid false positives on short names (1–2 token names like `getUser` vs `getUsers`), the threshold is adjusted by the token count of the head's last name segment.

The symbol kind does not enter into it. This section was headed "per-symbol-kind thresholds" and its pseudocode took a `kind` parameter that neither it nor the implementation ever read; §3.4.6 then quoted "for kind=method the threshold is 0.85" for a two-token name the table gives 0.95. Kind already does the work it can do in §3.4.0's bucket key, which stops a class body from being compared against a function at all.

```
thresholdFor(headName):
  tokenCount = tokenize(lastSegment(headName)).length
  if tokenCount <= 1:
    return 1.0                  # an exact match on both remaining axes
  if tokenCount == 2:
    return 0.95                 # strict (e.g. 'getUser' vs 'getUsers' scores 1/3 → does not pass)
  return 0.85                   # default
```

1.0 is the top of the scale and a reachable score: an identical member name and signature, past §3.4.6's gate, give `0.5 + 0.3 + 0.2`, exactly 1 in IEEE 754. The comparison is `score >= threshold`, so the first row pairs an unchanged `UserRepo.get` that moved file with an edited body — which stage 3 does not catch. The owner need not be identical, only compatible, so `UserRepo.get` → `UserRepos.get` reaches it too. Making it `>` would empty the row rather than tighten it.

##### Symbols stage 4 does not read

Two kinds of Symbol are skipped before any threshold applies, because for them a high score means the evidence is missing rather than that the two names resemble each other. Neither is expressible as a threshold, and one of them wants a bar above the top of the scale:

```
if h.signature === null:            skip the head entirely, leave for added/removed
if tokenize(s.name).length <= 1:    skip the Symbol, either side, leave for added/removed
```

**A null signature** makes `signatureSimilarity(null, null)` return 1.0 against every candidate. The bucket key partitions by signature nullness, so a signature-less head only ever sees signature-less candidates — there is nothing in its bucket it could legitimately pair with, and the rule needs no condition on them.

**A one-token qualified name** is the whole of what §3.4 has to read about that Symbol's identity. `main` supplies one word and an empty owner, so a top-level `main(x: string): void` scores 1.0 against any other top-level `main(x: string): void` and two unrelated CLI entry points are reported as one `moved+changed` — which `--fail-on moved` gates on. The first threshold row was written to prevent exactly this and could not, because 1.0 is the top of the scale.

The count is over the **whole qualified name** — the member and its owner together, which is everything §3.4 knows a Symbol by — and not over the last segment alone, which is what `thresholdFor` reads. `UserRepo.get` supplies three tokens and goes on pairing though its last segment supplies one; the threshold row that still governs it is the one above. Tokens are deduped (§3.4.1), so `Main.main` supplies one and is skipped: the formula cannot tell it from a bare `main`.

The rule reads **both sides**, because the property belongs to a pairing rather than to one end of it.

It once read the head alone, on an arithmetic licence: a one-token name on either side capped the score at `0.5 * 0.5 + 0.3 + 0.2 = 0.75`, under the table's lowest row, so a one-token base was unreachable without a check of its own. That held while the name axis was a Jaccard over the whole qualified name. §3.4.6's gate moved the axis to the last segment, and the ceiling went with it: `Main.main` is one deduped token, it clears the gate against `Mains.main` by inflection, and their member names are identical, so the pair scores 1.0. Reading both sides costs one test per Symbol and needs no licence.

**What this gives up.** A one-token name that moved file *and* changed body is now `added` + `removed` where it was one `moved+changed`. That band is narrow: stage 1 takes it if the id survives, stage 2 if git recorded the rename, stage 3 if the logic fingerprint is unchanged. What is left is a cross-file move git did not record, with an edited body — and for a name of one word, that pairing was never better than a guess.

The band is wider than it looks on codebases with non-Latin identifiers, because §3.4.1's tokeniser reads such a name as one token however much it says. `ユーザー情報を取得する` is refused on the same footing as `main`, and for that name the proxy is simply wrong: two unrelated Symbols do not carry it by coincidence. The rule keeps the count anyway rather than special-casing a script, because the fix is to measure what a name says by something better than a bare distinct-token count, and that is §3.4.1's to change. Tests pin the current behaviour so the change is visible when it comes.

Stage 3 is untouched by all of this: an identical logic fingerprint is proof on its own and does not ask the name to carry anything, so a `main` that moved file unchanged is still a move.

#### 3.4.4 Tuning via configuration

`config.diff.nameSignatureThreshold` (default: `null` = automatic, by the token count of §3.4.3's table) overriding the global threshold is planned — see the [roadmap](../roadmap.md). Currently the threshold is automatic only.

#### 3.4.5 Stage 4.5: dedicated weak matcher for dropped

Dropped symbols have zero fingerprints and cannot use stages 3/4. To catch dropped symbols that moved in environments without git rename, a lightweight dropped-only matcher runs after stage 4. Two signals remain: the trailing segment of the qualified name, and the file basename. Either one alone is enough to pair.

A signal counts only when it **identifies** a Symbol — when exactly one dropped base and one dropped head of that kind carry the key:

```
for keyOf in [ (kind, lastSegment(name)), (kind, basename(source.file)) ]:
  for key carried by exactly one dropped base AND exactly one dropped head:
    candidates.append((that base, that head))  # both keys may name the same pairing

for (b, h) in the largest subset of candidates that pairs each Symbol at most once:
  pair, rationale: 'dropped-weak-match'
```

As a result, a change such as "only renamed the directory of DTO files" is recorded as `moved:10` rather than `droppedAdded:10 / droppedRemoved:10`.

**Why identifying, and not just matching.** A key several Symbols carry names a group, and a group is not a pairing. `index.ts` is the most common filename in a TypeScript monorepo, so a bare basename match paired every dropped Symbol of one kind under one with every other — at a score they all tied on, which left the choice among unrelated classes to the tie-break. Those pairings land in `summary.moved`, which `--fail-on moved` gates on, so the false-positive budget this section grants itself was being spent on the default case rather than an unusual one. Requiring the key to identify costs the pairings where the surviving signal was ambiguous, which are the ones with nothing to distinguish the candidates by — the fingerprint is zeroed, so there is no second opinion to consult.

**The candidates carry no weight, so §3.8 does not apply.** Every candidate here is worth the same: a pairing both halves identify cannot be contested — both keys are sole on both sides and point at each other, so neither Symbol appears in any other candidate — and the case that remains, one base offered different heads by the two halves, is one the 0.5-per-half scale scored equally anyway. §3.8's sweep settles conflicts by score, and its licence to be greedy is that it never passes over the best available pairing; with no score there is no best, and it would drop one identified pairing for another over nothing but the id it sorts under. Three identified pairings over four Symbols where two can hold is not a hypothetical.

So this stage takes a **maximum matching**. Each axis identifies a Symbol at most once, so a Symbol carries at most two candidates and the set is the union of two matchings — a disjoint union of simple paths and even cycles, where alternate candidates along each component are a maximum matching and walking from a fixed end makes the choice among them canonical. That is also what bounds the work: at most one pairing per identifying key, two axes, against the cross-product a shared basename used to produce.

**"Exactly one" is counted over what reaches this stage**, not over every dropped symbol in the Document. Stages 1 and 2 have already taken theirs, so a key they emptied out identifies again. That is the intended reading — the question is which leftover a key picks out, and the stage is handed the leftovers — but it is also the ordinary way a shared `index.ts` still pairs unrelated symbols: three dropped classes under one, two of them unchanged and matched by id, and the basename identifies the two that remain.

So there is still a false-positive risk — that case, and two unrelated classes that are genuinely the sole carriers of one basename — but dropped symbols are outside the IR's primary field of view, so the impact is small.

#### 3.4.1 nameSimilarity

Token split (camelCase / snake_case / `.` / `::`) → Jaccard similarity. Levenshtein is too sensitive and was rejected.

```
tokenize("InvoiceService.createInvoice") = ["invoice", "service", "create", "invoice"] (lowercase, dedupe)
jaccard(A, B) = |A ∩ B| / |A ∪ B|
```

**The camel boundary is ASCII.** The split compares code points against `a`–`z`, `A`–`Z` and `0`–`9`, so a name written in a script with no ASCII case boundary and no separator comes back whole:

```
tokenize("ユーザー情報を取得する") = ["ユーザー情報を取得する"]     (1)
tokenize("获取用户信息")           = ["获取用户信息"]               (1)
tokenize("получитьПользователя")  = ["получитьпользователя"]       (1 — the camel hump does not register)
tokenize("ユーザー.取得")          = ["ユーザー", "取得"]           (2 — a separator still splits)
tokenize("UserRepo.取得")          = ["user", "repo", "取得"]       (3 — the ASCII half splits)
```

Jaccard is unharmed by this: two names that tokenise whole still score 1.0 against each other and 0 against anything else, which is the right answer for identical and for unrelated names alike. What it does harm is any reading of the **count** as a measure of how much a name says — §3.4.3's admissibility rule is the one place that does, and it states the cost there.

#### 3.4.6 The owner gate (R-8: avoiding same-name method collisions)

Two things must hold at once. A method whose class was renamed (`UserRepo.getUser` → `UsersRepository.getUser`) must pair, and a same-named method of a *different* class (`AdminRepo.getUser`) must not.

The owner is therefore a **gate**, not a term in the score: a pair whose owners are incompatible is never scored.

```
ownerOf(qname):
  if '::' in qname: return qname[:first index of '::']    # the Class:: portion of a static method
  if '.'  in qname: return qname[:last index of '.']      # the nested.namespace.Class portion
  return ''
  # 'Class::method' → 'Class'
  # 'A.B.C.method'  → 'A.B.C'
  # 'topLevel'      → ''   (empty)

ownersAreCompatible(baseName, headName):
  baseOwner = ownerOf(baseName)
  headOwner = ownerOf(headName)
  if baseOwner === '' && headOwner === '': return true    # both top-level: one shared scope
  if baseOwner === '' || headOwner === '': return false   # different depths
  if baseOwner === headOwner: return true                 # the common case

  # an owner is a path, so it corresponds segment by segment; within a segment every token on
  # each side needs a distinct partner on the other, under sameWord
  baseSegments = baseOwner.split('.')
  headSegments = headOwner.split('.')
  if len(baseSegments) != len(headSegments): return false
  return all(seg == cnt or perfectMatching(tokenize(seg), tokenize(cnt), sameWord)
             for seg, cnt in zip(baseSegments, headSegments))

sameWord(a, b):
  return a == b or inflectionOf(a, b)     # user/users, entity/entities. Nothing else.
```

As a result:

| pair | owners | verdict |
|---|---|---|
| `UserRepo.getUser` vs `UserRepos.getUser` | `repo` -> `repos` | compatible, scored 1.0, **pairs** |
| `EntityStore.findById` vs `EntitiesStore.findById` | `entity` -> `entities` | compatible, **pairs** |
| `Users.UserRepo.getUser` vs `Users.UserRepos.getUser` | segment by segment | compatible, **pairs** |
| `UserRepo.getUser` vs `AdminRepo.getUser` | `user` has no partner | **refused** |
| `RepoManager.load` vs `ReportManager.load` | `repo` is not `report` inflected | **refused** |

**Why a gate and not a weight.** The previous design added `0.2 * jaccardTokens(baseOwner, headOwner)` to the score, and could satisfy neither requirement.

It could not pair the rename, because the owner was counted twice. §3.4.1's name axis is a Jaccard over the *whole* qualified name, so a renamed owner already depressed the name term, and the owner term then charged for the same difference again: `UserRepo.getUser` vs `UsersRepository.getUser` scored `0.5*0.4 + 0.3 + 0.2*0 = 0.5`, not the 0.9 this section claimed. End to end, renaming a class and keeping three methods with edited bodies reported `added: 3 / removed: 3`.

And it could not refuse the collision, because a weight cannot outvote a perfect member name and signature. Reading the name axis on the last segment fixes the double count but inverts the ordering — `AdminRepo` *shares* the `repo` token where `UsersRepository` shares none:

| pair, both `.findById` | owner Jaccard | w=0.2 | w=0.3 | threshold |
|---|---|---|---|---|
| `UserRepo` vs `AdminRepo` — must refuse | 0.333 | 0.8667 | 0.8000 | 0.85 |
| `UserRepo` to `UsersRepository` — must pair | 0 | 0.8000 | 0.7000 | 0.85 |
| `UserRepoService` vs `AdminRepoService` — must refuse | 0.5 | 0.9000 | 0.8500 | 0.85 |

The collision outscores the rename at either weight, and the three-token collision passes at both. There is no weight at which "different class" reliably loses, because the quantity being weighed is not evidence of degree.

Past the gate there is no owner left to grade, so the owner axis is satisfied in full and the composite keeps the 0.5/0.3/0.2 shape §3.4.3's rows are calibrated against. Dropping the term and renormalising would move every threshold without changing what any of them means.

**Why inflection and nothing looser.** A prefix test is the obvious way to admit `repo` -> `repository`, and it cannot be made to work: it admits `repo`/`report`, `cache`/`cached`, `con`/`controller` — distinct classes, which is the collision this section exists to refuse. Nor is there a threshold to find, because the two populations interleave:

| | dice | levenshtein |
|---|---|---|
| accept `UserRepo`/`UsersRepository` | 0.571 | 7 |
| refuse `RepoManager`/`ReportManager` | 0.818 | 2 |
| accept `Repo`/`Repository` | 0.500 | 6 |
| refuse `CacheStore`/`CachedStore` | 0.842 | 1 |

The renames to accept score *lower* than the collisions to refuse, on both measures. A length-growth rule fares no better: `con` -> `controller` grows by 7 and `user` -> `users` by 1, so anything admitting the second admits the first.

Inflection is not on that spectrum. It is a closed, mechanical relation between two spellings of one word, so it can be recognised rather than estimated, and it covers the rename a plain equality test misses most often — a class pluralised in place.

**What the gate costs.** Three things, all falling through to `added` + `removed`, which is R-8's preferred direction of error:

- **The abbreviation family.** `UserRepo` -> `UsersRepository`, this section's original headline example, no longer clears the gate. That is the price of refusing `repo`/`report`, which no rule over the two strings alone can tell apart.
- **An added or dropped token.** `UserRepo` and `UserRepoV2` are two classes rather than one renamed; an added token is as much evidence of a sibling as of a rename.
- **A changed nesting depth.** A rename changes what a class is called, not where it lives, so `Services.UserRepo` and `UserRepo` are different scopes.

The evidence that would settle the first is not in the strings. The owner is itself a Symbol in the IR, so "was this class paired as a rename" is a question the stage could ask rather than guess at — which would mean stage 4 consuming its own output, and is the direction a future revision should take rather than a looser string rule.

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
2. Otherwise stage 4.5 attempts the `lastSegment(name) + basename(file)` weak match, on whichever of the two identifies a symbol (§3.4.5)
3. If still unmatched, counted independently as "dropped disappeared/appeared" (aggregated in the "dropped + changes" section of the diff report)

Dropped symbols are outside the IR's primary field of view, so the false-positive risk of stage 4.5 is accepted.

### 3.7 Identity collisions (fail-fast)

The diff keys three collections by identity. Stage 1 pairs Symbols by `id` (§3.1) and stages 2 to 4.5 track the base Symbols they have consumed by `id`; §6.1 maps Components by `id`; §6.2 maps Dependencies by the `(from, to, via)` triple. Repeat any of them and the diff still produces an answer — with an entry left out, an entry classified twice, or a change the two revisions do not contain — and nothing downstream can tell that answer from the real one. ir-schema §14 #1, #2 and #13 forbid all three for that reason, and this section is where that reason lives: the code and its tests refer here rather than restating it.

**At extraction time**, the Aburi core stops with a fatal error on:

- Multiple Symbols generated with the same ID (e.g., multiple `export default function` in the same file, or CJS `module.exports.default` coexisting with ESM `export default`)
- Two or more `<default>` symbols detected within the same file
- A dropped and a non-dropped symbol colliding on the same ID

The error message is `Symbol ID collision at <file>: <id>`, prompting the user to fix the offending location.

**At the diff entry point**, `buildDiff` checks the same three identities again before the first stage runs, because it is public API: an IR read off disk has been through the integrity checker, but one a caller assembled in memory has been through nothing. A collision raises `DiffError` with code `ir-identity-collision`, naming the side, the collection, the repeated value, and both positions. Establishing an identity means reading it, so the same pass also refuses an entry that is not an object or whose identity fields are not strings — without which a Symbol carrying no `id` has nothing to collide with and derives a Slice anchored on `undefined` several stages later.

The entry-point check is scoped to identity rather than delegating to the whole integrity checker. Most of the remaining rules would make `buildDiff` refuse a Document over something that does not change its answer — #3 (a `component` reference that resolves), #7 (the effect vocabulary) and #15 (the `callResolution` census) are all read by no part of the diff. Note that this argument does *not* extend to every rule. #19 (Unicode normalisation) changes the answer, because matching compares raw strings and an NFD id on one side misses the NFC spelling of the same name on the other. #11 (array ordering) changes it too, through §5.2: an array delta pairs elements by line within a window, so two IRs whose `rules[]` disagree only in the order of two same-typed rules twenty lines apart report two modifications rather than nothing. Neither is enforced here because the diff has no standing to rewrite its inputs, not because they are harmless — and note that #11 no longer reaches *matching*, which §3.8 makes independent of array order.

### 3.8 Choosing among candidate pairings

Stages 3, 4 and 4.5 each produce a set of possible pairings and have to settle them. `acceptInScoreOrder` sorts the candidates and sweeps once, taking a pairing when neither side has been taken already:

```
sort by (score descending, base.id ascending, head.id ascending)
for each candidate:
  if base and head are both still free:
    accept it
```

Two properties follow, and neither held when each head chose its own best in turn.

**The diff is a function of the two Documents, not of their array order.** `(base.id, head.id)` is a total order on candidates of equal score, because ids are unique within a Document (ir-schema §14 #1) — which §3.7 has `buildDiff` establish before the first stage runs. Without it, equal scores resolve to whichever candidate was enumerated first, and permuting `symbols[]` changes the bytes of `diff.json`.

**A better pairing is never passed over for a worse one.** Choosing per head consumed a base the moment some head wanted it, so an earlier head could take the base that was a later head’s exact match — putting one name in the output as an addition and as the source of a move at the same time.

The sweep is greedy, not an optimal assignment: a pairing can still be stranded because both of its partners were taken by higher-scoring ones. That is a deliberate stop — the case that misleads a reader is the *best available* pairing being skipped, and a greedy sweep in score order never does that.

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

Element identity criteria — the key that makes two elements *candidates*; choosing among
several candidates is §5.2.0:
- Rule: `(type)`, with the line fuzzed to ±2 (§5.2.1)
- Effect: `(id, target)`, with no line window at all
- Call: `(target)`, line fuzzed
- Decorator: `(name)`, line fuzzed (§5.2.2)

##### 5.2.0 Choosing among elements that share a key

A key does not identify one element. A Symbol routinely holds two `guard` rules, two calls to
one target, two `@Get` — so which base element a head element takes is a choice.

It is made in two passes, and each pass chooses a **set** of pairings rather than one at a
time:

```
for contentMustAgree in [true, false]:
  admissible(b, h) = same key
                     and |b.line - h.line| <= lineFuzz
                     and (content equal, if contentMustAgree)
  take the best set of admissible pairings over the elements still free, where
    - the pairings do not cross: i1 < i2 implies j1 < j2
    - more pairings beats fewer
    - among sets of equal size, less total |b.line - h.line| wins

unpaired head -> added
unpaired base -> removed
paired, contents differ -> modified   (the head element is the one emitted)
```

The first pass is what makes the answer readable. An element nothing touched has an exact
counterpart, so the pass that only considers exact counterparts claims it before an edited or
deleted neighbour can; whatever is left over is then paired by proximity, which is where a
genuine edit lands.

**Why non-crossing.** ir-schema §14 #11 orders these arrays by line, so `i < j` means element
`i` sits above element `j` in the file. Two pairings that crossed would have an element move
above one it was below — not a line shift but a different element. The constraint is also what
makes the best set reachable by a suffix recurrence rather than by a general assignment
algorithm, and what settles ties: between two otherwise indistinguishable candidates the one
that keeps the pairings in order is the one taken.

**Why a set and not one element at a time.** A greedy pass takes the pairing in front of it,
and a nearer pairing can cost a farther one its only partner:

| base | head | first key hit | nearest line, greedy | this rule |
|---|---|---|---|---|
| `guard@1 "!user"`, `guard@3 "!invoice"` | `guard@3 "!invoice"` | removed **and** modified `!invoice` | removed `!user` | removed `!user` |
| `guard@1 "!a"`, `guard@2 "!b"` | `guard@2 "!a"`, `guard@3 "!b"` | nothing | modified `!a`, modified `!b` | nothing |
| `guard@1 "!a"`, `guard@2 "!a"` | `guard@3 "!a"`, `guard@4 "!a"` | nothing | added `!a`, removed `!a` | nothing |

Row 1 is a deleted guard: taking the first key hit inside the window let the surviving guard
claim the deleted one's slot, so an untouched element was reported as `removed` and `modified`
at once, under contradictory buckets, and the element actually deleted appeared nowhere.

Row 2 is two guards shifted down a line together with nothing edited — the noise line fuzz
exists to suppress, which pairing by proximity alone reintroduces.

Row 3 is the same shift where the two guards are also *identical*, so the exact pass cannot
tell them apart either. Greedily, the first head element is nearest the **second** base
element; claiming it strands the other head outside the window, and a block that moved intact
comes back as an add and a remove. Choosing the pair of pairings together costs one more line
of total movement and reports nothing, which is the right answer. Two calls to one target and
two copies of one decorator are the ordinary way this arises.

**What is not promised.** The result depends on the order of the arrays, and cannot not: it
pairs by line, and #11 is what fixes that order. Reversing an array produces a different
answer — and a non-canonical Document. §3.8 achieves order-independence for Symbol pairing
because ids give it a total order that comes from content; §5.2 has no counterpart, and
§3.7 records the distinction.

##### 5.2.1 Rationale for line fuzz##### 5.2.1 Rationale for line fuzz

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
| Stage 4 (name+signature) | O(K x C) where K = remaining unmatched and C = bases sharing a member token (§3.4.0); O(K^2) when one token is shared by everything |

K is usually < 100 (most symbols are settled in stage 1). Effectively O(N), i.e. linear.

### 8.2 Memory

Both base and head Symbols are held in memory. Under 100MB for a medium monorepo (10k Symbols).
Large repositories (>100k) would require streaming, which is not yet supported.

Stage 4 additionally holds one record per candidate pairing (§3.8) — every (base, head) pair in a bucket that clears the head's threshold. That is O(1) in the ordinary case, where a threshold of 0.85 or above admits few pairs, and O(base × head) for a bucket whose members are near-identically named. The per-head loop it replaced held one record; the trade buys the guarantee that the best available pairing is never skipped, and §3.4.0's bucket pre-filter is what keeps the bound to a bucket rather than to the Document.

Stage 4.5 does not pay this. Its candidates are the keys that identify a pairing (§3.4.5), at most one each over two axes, so the list is bounded by the dropped Symbols themselves rather than by their pairs. The rule that bounds it is the same one that stops a shared `index.ts` from pairing unrelated Symbols: a key several Symbols carry identifies none of them.

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
Stage 4.5 runs with the false-positive risk priced in, under the premise that "dropped is outside the IR's primary field of view, so the impact is small" — but only on a key that identifies one symbol on each side, because a basename every symbol shares prices in no risk, it pairs at random.

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
