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

Two consequences worth stating:

- **The candidates carry no weight.** A pairing both halves identify cannot be contested,
  because both keys are sole on both sides and point at each other, so neither Symbol appears
  in any other candidate. What remains is one base offered different heads by the two halves,
  which the 0.5-per-half scale scored equally anyway. §3.8 settles the stage entirely on
  `(base.id, head.id)`, and the scale is gone rather than kept as a distinction that can
  never decide anything.
- **The bound comes for free.** At most one pairing per identifying key over two axes, so the
  candidate list is linear in the dropped Symbols rather than in their pairs — which is what
  a shared basename used to produce, and the reason the stage needed a specialised sweep.
  That sweep is gone; §3.8's is enough again.

`docs/design/diff-algorithm.md` §3.4.5 also still carried the candidate-list pseudocode from
before that specialised sweep, and §8.2 described the sweep itself. Both now match the code.
