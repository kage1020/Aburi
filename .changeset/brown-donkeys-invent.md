---
"@aburi/core": minor
"@aburi/diff": minor
"@aburi/markdown-projection": minor
"@aburi/cli": minor
"@aburi/types": minor
---

Record what the scan lost, and stop calling it removed API

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
answers "did this run drop anything" on its own, and absence *with* `totalFiles > parsedFiles`
identifies a document written before the field rather than a clean run.

**No `detail`.** The scan carries one per entry — the size, the elapsed, the message a plugin
refused the file with — but the `unreadable` detail is an OS error message containing the
**absolute** path, and a canonical document whose bytes depend on where the repository was
checked out is not the byte-stable artifact everything downstream assumes.

Integrity **invariant #21**: when present, `skippedFiles.length === totalFiles - parsedFiles`
and no path appears twice. The two sides are derived independently — `parsedFiles` from the
scan's own subtraction, the list from what it gave up on — so the check is a real one. It is
conditional on presence, because a document that predates the field cannot satisfy it and its
absence is itself the answer.

`workspace.md` gains a "Files not analysed" section grouping the paths by reason, so a reader
holding only the Markdown sees the same thing.

## `status: "unknown"`

`aburi diff` reads that list. A leftover Symbol whose `source.file` the *other* document never
analysed is no longer `removed` (or `added`) but `unknown`, carrying `absentFrom` — the
document that lost the file, so `head` reads as "this may still exist" and `base` as "this may
not be new" — and the skip `reason`, which is what decides the reader's next move.

Three properties this rests on:

- **Classified after the five matching stages, never before.** A Symbol that moved *out of* a
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
lost it and why. The summary line grows `· ?N unknown` only when there is one, so the line
skimmed on every PR does not carry a permanent `?0`.

## Not closed by this

`aburi scan` still exits `0` when a plugin refuses every file in the workspace — the document
now says so, but nothing gates on it. `aburi explain` and `aburi diff` still discard the scan
incident report entirely; this delivers the artifact half of that for `diff` and none of it
for `explain`. Both are tracked separately.
