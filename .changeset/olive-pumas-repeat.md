---
"@aburi/diff": minor
---

Pair dropped Symbols only on a signal that identifies one

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
