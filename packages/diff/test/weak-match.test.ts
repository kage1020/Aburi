import type { Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { buildDiff } from "../src"
import { makeIR, makeSymbol, zeroFp } from "./fixtures"

/**
 * §3.4.5 pairs dropped Symbols on two coarse signals — the trailing segment of the qualified
 * name, and the file basename — and accepts either one alone. The section grants itself a
 * false-positive budget on the grounds that dropped Symbols sit outside the IR's main review
 * surface, but a basename hit on `index.ts` is not a weak signal, it is no signal: it is the
 * most common filename in a TypeScript monorepo, so every dropped Symbol of one kind under
 * one matched every other, and the pairings landed in `summary.moved`, which `--fail-on
 * moved` gates on.
 *
 * A signal has to identify something to be evidence. A key that exactly one dropped base and
 * one dropped head carry names a pair; a key that several carry names a group, and a group
 * is not a pairing.
 */

const IR_REF = { ref: "test", irSchema: "aburi.ir.v1.json" } as const

function dropped(file: string, name: string, kind: IRSymbol["kind"] = "class"): IRSymbol {
  return makeSymbol({
    id: `ts:${file}#${name}`,
    name,
    kind,
    dropped: true,
    dropReason: "size",
    fingerprint: zeroFp(),
    source: { file, startLine: 1, endLine: 2 },
  })
}

function weakPairs(base: IRSymbol[], head: IRSymbol[]): string[] {
  const diff = buildDiff({
    baseIR: makeIR({ symbols: base }),
    headIR: makeIR({ symbols: head }),
    base: IR_REF,
    head: IR_REF,
  })
  return diff.symbols
    .filter((change) => change.status === "moved" || change.status === "moved+changed")
    .map((change) =>
      change.status === "moved" || change.status === "moved+changed"
        ? `${change.before.id} -> ${change.after.id}`
        : "",
    )
}

describe("a key several Symbols carry is not evidence of a pairing", () => {
  it("does not pair unrelated dropped classes through a shared `index.ts`", () => {
    // Four unrelated DTOs, no two of which share a name. Every basename is `index.ts`, which
    // used to be worth 0.5 on its own — enough to pair, and every score tied, so which
    // unrelated class paired with which was the tie-break's choice.
    const base = [
      dropped("src/billing/index.ts", "InvoiceDto"),
      dropped("src/auth/index.ts", "LoginDto"),
    ]
    const head = [
      dropped("src/orders/index.ts", "OrderDto"),
      dropped("src/shipping/index.ts", "ShipmentDto"),
    ]
    expect(weakPairs(base, head)).toEqual([])
  })

  it("counts the whole dropped set, not the pair in front of it", () => {
    // The basename `Dto.ts` identifies nothing on the base side, so it cannot pair the head
    // that carries it either — even though on the head side it is unique.
    const base = [dropped("src/a/Dto.ts", "Alpha"), dropped("src/b/Dto.ts", "Beta")]
    const head = [dropped("src/c/Dto.ts", "Gamma")]
    expect(weakPairs(base, head)).toEqual([])
  })

  it("applies the same rule to the name half", () => {
    const base = [dropped("src/a/One.ts", "Svc.handle")]
    const head = [dropped("src/b/Two.ts", "Svc.handle"), dropped("src/c/Three.ts", "Other.handle")]
    expect(weakPairs(base, head)).toEqual([])
  })

  it("still gates on kind before either half is read", () => {
    const base = [dropped("src/a/Dto.ts", "Alpha", "class")]
    const head = [dropped("src/b/Dto.ts", "Alpha", "method")]
    expect(weakPairs(base, head)).toEqual([])
  })
})

describe("the moves §3.4.5 exists to catch still land", () => {
  it("a renamed directory of DTO files", () => {
    // The section's own headline example. Each name and each basename identifies one Symbol
    // on each side, so all ten pair on both halves.
    const names = [
      "Invoice",
      "Order",
      "Ship",
      "Login",
      "Token",
      "User",
      "Cart",
      "Item",
      "Tax",
      "Fee",
    ]
    const base = names.map((n) => dropped(`src/billing/${n}Dto.ts`, `${n}Dto`))
    const head = names.map((n) => dropped(`src/orders/${n}Dto.ts`, `${n}Dto`))
    expect(weakPairs(base, head)).toHaveLength(10)
  })

  it("a renamed directory whose DTOs all live in one `index.ts`", () => {
    // The basename contributes nothing here — it is `index.ts` on both sides and carried by
    // three Symbols each — and the names carry the pairing on their own.
    const base = ["Alpha", "Beta", "Gamma"].map((n) => dropped("src/billing/index.ts", n))
    const head = ["Alpha", "Beta", "Gamma"].map((n) => dropped("src/orders/index.ts", n))
    expect(weakPairs(base, head)).toEqual([
      "ts:src/billing/index.ts#Alpha -> ts:src/orders/index.ts#Alpha",
      "ts:src/billing/index.ts#Beta -> ts:src/orders/index.ts#Beta",
      "ts:src/billing/index.ts#Gamma -> ts:src/orders/index.ts#Gamma",
    ])
  })

  it("a renamed file whose class kept its name", () => {
    expect(
      weakPairs(
        [dropped("src/billing/Invoice.ts", "InvoiceDto")],
        [dropped("src/billing/InvoiceDto.ts", "InvoiceDto")],
      ),
    ).toEqual(["ts:src/billing/Invoice.ts#InvoiceDto -> ts:src/billing/InvoiceDto.ts#InvoiceDto"])
  })

  it("a renamed class whose file kept its name", () => {
    // The half that survives here is the basename, and `Dto.ts` identifies one Symbol on each
    // side — which is the difference between it and `index.ts`, not the filename itself.
    expect(
      weakPairs(
        [dropped("src/billing/Dto.ts", "InvoiceDto")],
        [dropped("src/billing/Dto.ts", "BillDto")],
      ),
    ).toEqual(["ts:src/billing/Dto.ts#InvoiceDto -> ts:src/billing/Dto.ts#BillDto"])
  })
})

describe("as many identified pairings hold as can", () => {
  it("does not strand two pairings to take one", () => {
    // Three identified pairings over four Symbols: `Alpha -> Alpha` by the name half,
    // `Shared.ts` and `Other.ts` by the file half. Taking the name pairing first — which is
    // what settling by id does — consumes both Symbols the other two needed.
    const base = [dropped("src/a/Shared.ts", "Alpha"), dropped("src/b/Other.ts", "Beta")]
    const head = [dropped("src/x/Other.ts", "Alpha"), dropped("src/y/Shared.ts", "Gamma")]
    expect(weakPairs(base, head)).toEqual([
      "ts:src/b/Other.ts#Beta -> ts:src/x/Other.ts#Alpha",
      "ts:src/a/Shared.ts#Alpha -> ts:src/y/Shared.ts#Gamma",
    ])
  })

  it("pairs every Symbol of a closed chain", () => {
    // A cycle: each base is identified with one head by its name and another by its file, all
    // the way round. Every Symbol can be paired, and a walk that started mid-component or
    // stopped alternating would leave two out.
    const base = [dropped("src/a/One.ts", "Alpha"), dropped("src/b/Two.ts", "Beta")]
    const head = [dropped("src/x/One.ts", "Beta"), dropped("src/y/Two.ts", "Alpha")]
    expect(weakPairs(base, head)).toHaveLength(2)
  })

  it("takes the same pairings whichever order the arrays are written in", () => {
    const base = [dropped("src/a/Shared.ts", "Alpha"), dropped("src/b/Other.ts", "Beta")]
    const head = [dropped("src/x/Other.ts", "Alpha"), dropped("src/y/Shared.ts", "Gamma")]
    const forward = weakPairs(base, head)
    expect(weakPairs([...base].reverse(), [...head].reverse())).toEqual(forward)
    expect(weakPairs([...base].reverse(), head)).toEqual(forward)
    expect(weakPairs(base, [...head].reverse())).toEqual(forward)
  })
})

describe("a key identifies among the Symbols this stage was handed", () => {
  it("counts what the earlier stages left, not every dropped Symbol", () => {
    // Three dropped classes a side under one `index.ts` each. Two keep their ids and leave
    // through stage 1, which empties the basename out until it identifies the two that are
    // left — so a shared `index.ts` can still pair unrelated classes, in the common case
    // where most dropped Symbols are unchanged. The stage is handed the leftovers and has no
    // way to count the rest, and counting the leftovers is the question it is answering.
    const base = [
      dropped("src/a/index.ts", "Foo"),
      dropped("src/a/index.ts", "Qux"),
      dropped("src/a/index.ts", "Bar"),
    ]
    const head = [
      dropped("src/a/index.ts", "Foo"),
      dropped("src/a/index.ts", "Qux"),
      dropped("src/b/index.ts", "Baz"),
    ]
    expect(weakPairs(base, head)).toEqual(["ts:src/a/index.ts#Bar -> ts:src/b/index.ts#Baz"])
  })
})

describe("the two halves have equal standing", () => {
  it("reports a pairing both halves identify once", () => {
    // Both keys pick out the same pairing, so it is collected twice. It needs no dedup: each
    // key being sole on both sides means neither Symbol carries another pairing, so the
    // repeat is a component of its own and is taken once like any other.
    const base = [dropped("src/a/Dto.ts", "Alpha")]
    const head = [dropped("src/b/Dto.ts", "Alpha")]
    expect(weakPairs(base, head)).toEqual(["ts:src/a/Dto.ts#Alpha -> ts:src/b/Dto.ts#Alpha"])
  })

  it("settles one base offered two heads on the lower head id", () => {
    // The name half points at `src/z/...`, the file half at `src/c/...`. §3.4.5 scores the
    // halves equally, so neither axis outranks the other and §3.8's id keys decide.
    const base = [dropped("src/a/Shared.ts", "Alpha")]
    const head = [dropped("src/c/Shared.ts", "Beta"), dropped("src/z/Other.ts", "Alpha")]
    expect(weakPairs(base, head)).toEqual(["ts:src/a/Shared.ts#Alpha -> ts:src/c/Shared.ts#Beta"])
  })

  it("settles two bases offered one head on the lower base id", () => {
    const base = [dropped("src/a/Other.ts", "Alpha"), dropped("src/b/Shared.ts", "Beta")]
    const head = [dropped("src/x/Shared.ts", "Alpha")]
    expect(weakPairs(base, head)).toEqual(["ts:src/a/Other.ts#Alpha -> ts:src/x/Shared.ts#Alpha"])
  })

  it("neither half is consulted before the other", () => {
    // Same shape as above with the axes swapped: if the file half were collected first and
    // allowed to claim, the answer would follow the axis rather than the id.
    const base = [dropped("src/a/Shared.ts", "Beta"), dropped("src/b/Other.ts", "Alpha")]
    const head = [dropped("src/x/Shared.ts", "Alpha")]
    expect(weakPairs(base, head)).toEqual(["ts:src/a/Shared.ts#Beta -> ts:src/x/Shared.ts#Alpha"])
  })
})
