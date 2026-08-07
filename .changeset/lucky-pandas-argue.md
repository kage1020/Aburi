---
"@aburi/diff": minor
---

Settle candidate pairings by score and id rather than by array order

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
misleads a reader is the *best available* pairing being skipped, and this never does that.

Unchanged: every threshold, every rationale, stage 3's unconditional single-candidate branch
and the cascade that feeds it, and the rule that a signature-less head is never paired.

Two side effects worth naming:

- Stage 3 used to hand stage 4 a `remainingBase` reordered by fingerprint-bucket insertion,
  and stage 4.5 moved non-dropped symbols to the front of what it returned. Every stage now
  returns its inputs filtered, so the arrays keep the caller's order throughout.
- Scoring the whole bucket for every head, rather than one that shrank as heads consumed it,
  roughly doubles the similarities computed. `createNameScorer` tokenises each distinct name
  once per matching pass instead of once per comparison, which more than covers it: for a
  bucket of 1000 on each side, stage 4 goes from 2785 ms to 488 ms, and at 2000 from 8789 ms
  to 3876 ms.
