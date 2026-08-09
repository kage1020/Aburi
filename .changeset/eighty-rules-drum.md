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

The rule reads both sides of a pairing, since either end being short is enough to make the
score unearned.

**What this gives up.** A one-token name that moved file *and* changed body is reported as
`added` + `removed` where it was one `moved+changed`. The band is narrow — stage 1 takes it if
the id survives, stage 2 if git recorded the rename, stage 3 if the logic fingerprint is
unchanged — leaving a cross-file move git did not record, with an edited body.

It is wider on codebases with non-Latin identifiers. `tokenizeName` finds camel boundaries by
ASCII code-point range, so `ユーザー情報を取得する` and `获取用户信息` are one token each and
are refused on the same footing as `main` — for those names the count is a bad proxy for how
much the name says. The rule keeps the count rather than special-casing a script: the fix is a
better measure in §3.4.1, which every caller of `tokenizeName` reads, so it belongs in its own
change. §3.4.1 and §3.4.3 state the boundary and tests pin the behaviour.
