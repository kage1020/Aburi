---
"@aburi/diff": patch
---

Index stage 4's buckets by member token, so a bulk rename is not a cross-product

§3.4.0 partitions the base Symbols by `(kind, signatureNullness)` and calls the result
near-linear on the grounds that a bucket holds "a few dozen". A directory rename with no git
rename information — the §9.4 plugin-difference and §11.5 shallow-clone situations — puts every
method of the codebase in one bucket, so stage 4 scored the whole cross-product: 64 s at 4000
symbols against §8.3's 2 s target.

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

The order of the three per-candidate tests turned out to matter as much as the index, because
either of the first two can be the selective one — a corpus where every member name agrees and
the owners differ is decided entirely by the gate, and the reverse for a corpus of varied
names. They now run cheapest-first: `sameOwner` (a string compare), then the member floor (one
Jaccard over token sets the pass already holds), then §3.4.6's gate. The gate itself answers
early where it can, on identical owners and on owners whose first segments cannot correspond.

Measured on a directory rename with an edited body, no git rename information, everything in
one bucket (median of five):

| | before | after |
|---|---|---|
| 4000 symbols, varied names | 14.0 s | 1.3 s |
| 4000 symbols, every member name identical | 13.4 s | 13.5 s |

The second row is the shape no index helps with — one token, carried by everything — and the
fallback is what keeps it from getting worse. The first is now inside §8.3's target.

An earlier attempt memoised the gate on the owner pair, which is unbounded: a bulk rename
produces as many distinct owner pairs as candidates, and 4000 symbols exceeded V8's `Map`
limit outright. The shortcuts here allocate nothing.
