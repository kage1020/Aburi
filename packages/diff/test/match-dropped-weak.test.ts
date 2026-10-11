import { describe, expect, it } from "vitest"
import { changesBetween, diffSymbols, dropped } from "./helpers"

describe("a key several dropped Symbols carry is not evidence of a pairing", () => {
  it.each([
    [
      "unrelated classes share an `index.ts` basename",
      [dropped("src/billing/index.ts", "InvoiceDto"), dropped("src/auth/index.ts", "LoginDto")],
      [dropped("src/orders/index.ts", "OrderDto"), dropped("src/shipping/index.ts", "ShipmentDto")],
    ],
    [
      "the basename is shared among the whole dropped set, not the pair in front of it",
      [dropped("src/a/Dto.ts", "Alpha"), dropped("src/b/Dto.ts", "Beta")],
      [dropped("src/c/Dto.ts", "Gamma")],
    ],
    [
      "the member name is shared",
      [dropped("src/a/One.ts", "Svc.handle")],
      [dropped("src/b/Two.ts", "Svc.handle"), dropped("src/c/Three.ts", "Other.handle")],
    ],
    [
      "both keys match across two kinds",
      [dropped("src/a/Dto.ts", "Alpha", "class")],
      [dropped("src/b/Dto.ts", "Alpha", "method")],
    ],
  ])("pairs nothing when %s", (_, base, head) => {
    expect(changesBetween(base, head)).toEqual([])
  })

  it("counts a pair that shares neither key as one dropped addition and one dropped removal", () => {
    const diff = diffSymbols(
      [dropped("src/a/One.ts", "Svc.alpha", "method")],
      [dropped("src/b/Two.ts", "Svc.beta", "method")],
    )
    expect(diff.symbols).toEqual([])
    expect(diff.summary).toMatchObject({ droppedAdded: 1, droppedRemoved: 1, moved: 0 })
  })
})

describe("the moves the dropped weak match exists to catch", () => {
  it("pairs a renamed directory of DTO files", () => {
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
    expect(changesBetween(base, head)).toHaveLength(names.length)
  })

  it("pairs a renamed directory whose DTOs all live in one `index.ts`", () => {
    const base = ["Alpha", "Beta", "Gamma"].map((n) => dropped("src/billing/index.ts", n))
    const head = ["Alpha", "Beta", "Gamma"].map((n) => dropped("src/orders/index.ts", n))
    expect(changesBetween(base, head)).toEqual([
      "moved ts:src/billing/index.ts#Alpha -> ts:src/orders/index.ts#Alpha",
      "moved ts:src/billing/index.ts#Beta -> ts:src/orders/index.ts#Beta",
      "moved ts:src/billing/index.ts#Gamma -> ts:src/orders/index.ts#Gamma",
    ])
  })

  it.each([
    [
      "a renamed file whose class kept its name",
      dropped("src/billing/Invoice.ts", "InvoiceDto"),
      dropped("src/billing/InvoiceDto.ts", "InvoiceDto"),
    ],
    [
      "a renamed class whose file kept its name",
      dropped("src/billing/Dto.ts", "InvoiceDto"),
      dropped("src/billing/Dto.ts", "BillDto"),
    ],
    [
      "a DTO both keys identify",
      dropped("src/a/Dto.ts", "Alpha"),
      dropped("src/b/Dto.ts", "Alpha"),
    ],
  ])("pairs %s once", (_, base, head) => {
    expect(changesBetween([base], [head])).toEqual([`moved ${base.id} -> ${head.id}`])
  })
})

describe("as many identified pairings hold as can", () => {
  const base = [dropped("src/a/Shared.ts", "Alpha"), dropped("src/b/Other.ts", "Beta")]
  const head = [dropped("src/x/Other.ts", "Alpha"), dropped("src/y/Shared.ts", "Gamma")]

  it("does not strand two pairings to take the one between them", () => {
    expect(changesBetween(base, head)).toEqual([
      "moved ts:src/b/Other.ts#Beta -> ts:src/x/Other.ts#Alpha",
      "moved ts:src/a/Shared.ts#Alpha -> ts:src/y/Shared.ts#Gamma",
    ])
  })

  it("takes the same pairings whichever order the arrays are written in", () => {
    const forward = changesBetween(base, head)
    expect(changesBetween([...base].reverse(), [...head].reverse())).toEqual(forward)
    expect(changesBetween([...base].reverse(), head)).toEqual(forward)
    expect(changesBetween(base, [...head].reverse())).toEqual(forward)
  })

  it("pairs every Symbol of a closed chain", () => {
    expect(
      changesBetween(
        [dropped("src/a/One.ts", "Alpha"), dropped("src/b/Two.ts", "Beta")],
        [dropped("src/x/One.ts", "Beta"), dropped("src/y/Two.ts", "Alpha")],
      ),
    ).toHaveLength(2)
  })
})

describe("a key identifies among the Symbols this stage was handed", () => {
  it("counts what the earlier stages left, not every dropped Symbol", () => {
    const base = ["Foo", "Qux", "Bar"].map((n) => dropped("src/a/index.ts", n))
    const head = [
      dropped("src/a/index.ts", "Foo"),
      dropped("src/a/index.ts", "Qux"),
      dropped("src/b/index.ts", "Baz"),
    ]
    expect(changesBetween(base, head)).toEqual([
      "moved ts:src/a/index.ts#Bar -> ts:src/b/index.ts#Baz",
    ])
  })
})

describe("a conflict between the two keys", () => {
  it.each([
    [
      "one base is offered two heads, settling on the lower head id",
      [dropped("src/a/Shared.ts", "Alpha")],
      [dropped("src/c/Shared.ts", "Beta"), dropped("src/z/Other.ts", "Alpha")],
      "moved ts:src/a/Shared.ts#Alpha -> ts:src/c/Shared.ts#Beta",
    ],
    [
      "two bases are offered one head, settling on the lower base id",
      [dropped("src/a/Other.ts", "Alpha"), dropped("src/b/Shared.ts", "Beta")],
      [dropped("src/x/Shared.ts", "Alpha")],
      "moved ts:src/a/Other.ts#Alpha -> ts:src/x/Shared.ts#Alpha",
    ],
    [
      "the basename names the lower base id, so neither key comes first",
      [dropped("src/a/Shared.ts", "Beta"), dropped("src/b/Other.ts", "Alpha")],
      [dropped("src/x/Shared.ts", "Alpha")],
      "moved ts:src/a/Shared.ts#Beta -> ts:src/x/Shared.ts#Alpha",
    ],
  ])("is settled the same in either order when %s", (_, base, head, expected) => {
    expect(changesBetween(base, head)).toEqual([expected])
    expect(changesBetween([...base].reverse(), [...head].reverse())).toEqual([expected])
  })
})
