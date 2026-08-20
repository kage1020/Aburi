---
"@aburi/diff": minor
"@aburi/markdown-projection": minor
"@aburi/types": minor
---

Name the files neither revision analysed, in the diff rather than only on stderr

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

**Emitted unconditionally, empty array included.** The issue proposed Class B (omit when empty),
which is the IR's convention; the diff's is the opposite and this follows the diff's, per
`docs/design/diff-algorithm.md` §10.1. An IR reader can fall back on `totalFiles - parsedFiles`
to tell "nothing was lost" from "this writer could not say"; a diff reader has nothing to fall
back on, so the writer says it. Schema-optionality covers only documents written before the field
existed, and the Markdown section is omitted for those rather than reporting a clean run.

**Not in scope.** `--fail-on` gains no token. A workspace with a permanent over-size bundle would
trip a bare one on every pull request, which is an argument for a threshold rather than a flag,
and the same question is already open for the dependency side. And the ref form of `aburi diff`
still discards both `ScanResult.skipped` lists after keeping `irPath`, so the richer per-file
detail those carry is unavailable to the command that just produced them — that is its own
issue, and this field needs only what `stats.skippedFiles` already persists.

Every `diff.json` gains the key, so a byte-exact or snapshot comparison against one written by an
older version will differ.

Verification: 9 tests in `packages/diff/test/not-compared.test.ts`, five ajv instance cases, five
projection cases, and one CLI case asserting the written artifact rather than the return value.
The primary fixture skips the same path for *different* reasons on the two sides, because every
fixture where they agree is blind to the two being swapped.
