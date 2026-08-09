---
"@aburi/diff": minor
---

Make the owner a gate, so a renamed class keeps its methods

§3.4.6 (R-8) has two jobs: pair `UserRepo.getUser` with `UsersRepository.getUser` when the
class is renamed, and keep it away from `AdminRepo.getUser`, which is a different class. It
could do neither, and all three of its worked examples disagreed with the code.

**The owner was counted twice.** §3.4.1's name axis is a Jaccard over the *whole* qualified
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
segment fixes the double count and inverts the ordering: `AdminRepo` *shares* the `repo` token
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
refuses. Nor is there a threshold to find — the renames to accept score *lower* than the
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
