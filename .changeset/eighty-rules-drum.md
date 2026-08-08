---
"@aburi/diff": minor
---

Stop pairing Symbols whose name says one word

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
  *from the name* stopped reasoning from one word.

The rule reads the head, though the property belongs to a pairing, and that is a cost choice
rather than a semantic one: one token against two or more is a Jaccard of at most 1/2, capping
the total at `0.5 * 0.5 + 0.3 + 0.2 = 0.75` — under the lowest threshold left — so the only
pairing this changes is one short on both sides. Skipping the head costs one test; testing
the base would cost one per candidate.
