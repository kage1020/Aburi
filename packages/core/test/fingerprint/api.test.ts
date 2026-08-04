import type { Symbol as IRSymbol, Signature } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { makeLanguageId } from "../../src/id"
import { apiFingerprint } from "../../src/index"
import { makeSymbol } from "../fixtures/ir"

/**
 * Signature narrowing helper. base() always constructs a Symbol with a non-null signature,
 * but TypeScript still sees `Signature | null | undefined` on the field; extracting through
 * this helper keeps every test free of `!` assertions (banned by the codebase's linter
 * rules) while giving each test a fresh Signature to patch.
 */
function sig(sym: IRSymbol): Signature {
  if (sym.signature === null || sym.signature === undefined) {
    throw new Error("test fixture invariant: base() must produce a Symbol with a signature")
  }
  return sym.signature
}

function base(): IRSymbol {
  return makeSymbol("ts:src/a.ts#InvoiceService.createInvoice", {
    kind: "method",
    name: "InvoiceService.createInvoice",
    visibility: "public",
    signature: {
      inputs: [{ name: "dto", type: "CreateInvoiceDto" }],
      outputs: ["Promise<Invoice>"],
      throws: ["CreditLimitExceeded"],
      async: true,
      generator: false,
      typeParameters: [],
    },
  })
}

describe("apiFingerprint — 12-hex determinism", () => {
  it("returns exactly 12 lowercase hex characters", () => {
    const fp = apiFingerprint(base())
    expect(fp).toMatch(/^[0-9a-f]{12}$/)
  })

  it("T1: two calls on the same Symbol produce the same hash", () => {
    const sym = base()
    expect(apiFingerprint(sym)).toBe(apiFingerprint(sym))
  })

  it("T1b: 100 identical inputs never diverge", () => {
    const sym = base()
    const first = apiFingerprint(sym)
    for (let i = 0; i < 100; i++) expect(apiFingerprint(sym)).toBe(first)
  })
})

describe("apiFingerprint — invariance", () => {
  it("A1: renaming signature.inputs[].name does not change the hash", () => {
    const sym = base()
    const before = apiFingerprint(sym)
    const renamed = makeSymbol(sym.id, {
      ...sym,
      signature: {
        ...sig(sym),
        inputs: [{ name: "input", type: "CreateInvoiceDto" }],
      },
    })
    expect(apiFingerprint(renamed)).toBe(before)
  })

  it("A2: mutating rules and effects does not change the hash", () => {
    const sym = base()
    const before = apiFingerprint(sym)
    const mutated = makeSymbol(sym.id, {
      ...sym,
      rules: [
        { type: "guard", line: 5, condition: "x > 0", what: null, expr: null, loopKind: null },
      ],
      effects: [
        {
          id: "db.write",
          target: "prisma.invoice.create",
          line: 7,
          plugin: "effects-prisma",
          confidence: "high",
          derivedBy: "convention:test",
        },
      ],
    })
    expect(apiFingerprint(mutated)).toBe(before)
  })

  it("A3: swapping decorator declaration order does not change the hash", () => {
    const decoratorA = {
      name: "Post",
      raw: "Post('/invoices')",
      arguments: ["'/invoices'"],
      boundary: true,
      line: 12,
    }
    const decoratorB = {
      name: "UseGuards",
      raw: "UseGuards(RolesGuard)",
      arguments: ["RolesGuard"],
      boundary: false,
      line: 13,
    }
    const ab = makeSymbol("ts:src/a.ts#foo", { decorators: [decoratorA, decoratorB] })
    const ba = makeSymbol("ts:src/a.ts#foo", { decorators: [decoratorB, decoratorA] })
    expect(apiFingerprint(ab)).toBe(apiFingerprint(ba))
  })

  it("A12: changing the class scope but keeping the leaf does not change the hash", () => {
    const oldClass = makeSymbol("ts:src/a.ts#Old.createInvoice", {
      ...base(),
      name: "Old.createInvoice",
    })
    const newClass = makeSymbol("ts:src/a.ts#New.createInvoice", {
      ...base(),
      name: "New.createInvoice",
    })
    expect(apiFingerprint(oldClass)).toBe(apiFingerprint(newClass))
  })

  it("A13: changing language does not change the api hash (language is not part of the input)", () => {
    const asTs = makeSymbol(base().id, { ...base(), language: makeLanguageId("ts") })
    const asTsx = makeSymbol(base().id, { ...base(), language: makeLanguageId("tsx") })
    expect(apiFingerprint(asTs)).toBe(apiFingerprint(asTsx))
  })

  it("throws set is order-insensitive (sorted before hashing)", () => {
    const sym = base()
    const twoInOrder = makeSymbol(sym.id, {
      ...sym,
      signature: { ...sig(sym), throws: ["A", "B"] },
    })
    const twoReversed = makeSymbol(sym.id, {
      ...sym,
      signature: { ...sig(sym), throws: ["B", "A"] },
    })
    expect(apiFingerprint(twoInOrder)).toBe(apiFingerprint(twoReversed))
  })
})

describe("apiFingerprint — change conditions", () => {
  const beforeFp = apiFingerprint(base())

  it("A4: visibility change perturbs the hash", () => {
    const sym = makeSymbol(base().id, { ...base(), visibility: "private" })
    expect(apiFingerprint(sym)).not.toBe(beforeFp)
  })

  it("A5: adding a signature output perturbs the hash", () => {
    const sym = makeSymbol(base().id, {
      ...base(),
      signature: { ...sig(base()), outputs: ["Promise<Invoice>", "Metadata"] },
    })
    expect(apiFingerprint(sym)).not.toBe(beforeFp)
  })

  it("A6: adding a throws entry perturbs the hash", () => {
    const sym = makeSymbol(base().id, {
      ...base(),
      signature: { ...sig(base()), throws: ["CreditLimitExceeded", "AuditFailed"] },
    })
    expect(apiFingerprint(sym)).not.toBe(beforeFp)
  })

  it("A7: adding a decorator perturbs the hash", () => {
    const sym = makeSymbol(base().id, {
      ...base(),
      decorators: [
        {
          name: "Post",
          raw: "Post('/invoices')",
          arguments: ["'/invoices'"],
          boundary: true,
          line: 12,
        },
      ],
    })
    expect(apiFingerprint(sym)).not.toBe(beforeFp)
  })

  it("A8: changing a decorator argument perturbs the hash", () => {
    const a = makeSymbol(base().id, {
      ...base(),
      decorators: [
        {
          name: "Post",
          raw: "Post('/invoices')",
          arguments: ["'/invoices'"],
          boundary: true,
          line: 12,
        },
      ],
    })
    const b = makeSymbol(base().id, {
      ...base(),
      decorators: [
        {
          name: "Post",
          raw: "Post('/customers')",
          arguments: ["'/customers'"],
          boundary: true,
          line: 12,
        },
      ],
    })
    expect(apiFingerprint(a)).not.toBe(apiFingerprint(b))
  })

  it("A9: toggling async perturbs the hash", () => {
    const sync = makeSymbol(base().id, {
      ...base(),
      signature: { ...sig(base()), async: false },
    })
    expect(apiFingerprint(sync)).not.toBe(beforeFp)
  })

  it("A10: kind change perturbs the hash", () => {
    const sym = makeSymbol(base().id, { ...base(), kind: "function" })
    expect(apiFingerprint(sym)).not.toBe(beforeFp)
  })

  it("A11: extKind change perturbs the hash", () => {
    const sym = makeSymbol(base().id, { ...base(), extKind: "framework:nestjs:controller" })
    expect(apiFingerprint(sym)).not.toBe(beforeFp)
  })

  it("A14: shortName change perturbs the hash", () => {
    const sym = makeSymbol(base().id, { ...base(), name: "InvoiceService.updateInvoice" })
    expect(apiFingerprint(sym)).not.toBe(beforeFp)
  })

  it("A9b: toggling generator perturbs the hash", () => {
    const gen = makeSymbol(base().id, {
      ...base(),
      signature: { ...sig(base()), generator: true },
    })
    expect(apiFingerprint(gen)).not.toBe(beforeFp)
  })

  it("A15: adding a typeParameter perturbs the hash", () => {
    const withParam = makeSymbol(base().id, {
      ...base(),
      signature: { ...sig(base()), typeParameters: ["T"] },
    })
    expect(apiFingerprint(withParam)).not.toBe(beforeFp)
  })

  it("A15b: changing a typeParameter constraint perturbs the hash", () => {
    const a = makeSymbol(base().id, {
      ...base(),
      signature: { ...sig(base()), typeParameters: ["T extends string"] },
    })
    const b = makeSymbol(base().id, {
      ...base(),
      signature: { ...sig(base()), typeParameters: ["T extends number"] },
    })
    expect(apiFingerprint(a)).not.toBe(apiFingerprint(b))
  })

  it("A16: toggling Decorator.boundary perturbs the hash", () => {
    const asBoundary = makeSymbol(base().id, {
      ...base(),
      decorators: [
        {
          name: "Post",
          raw: "Post('/invoices')",
          arguments: ["'/invoices'"],
          boundary: true,
          line: 12,
        },
      ],
    })
    const notBoundary = makeSymbol(base().id, {
      ...base(),
      decorators: [
        {
          name: "Post",
          raw: "Post('/invoices')",
          arguments: ["'/invoices'"],
          boundary: false,
          line: 12,
        },
      ],
    })
    expect(apiFingerprint(asBoundary)).not.toBe(apiFingerprint(notBoundary))
  })
})

describe("apiFingerprint — order preservation", () => {
  it("A17: swapping signature.inputs order perturbs the hash (positional contract)", () => {
    const ab = makeSymbol(base().id, {
      ...base(),
      signature: {
        ...sig(base()),
        inputs: [
          { name: "a", type: "A" },
          { name: "b", type: "B" },
        ],
      },
    })
    const ba = makeSymbol(base().id, {
      ...base(),
      signature: {
        ...sig(base()),
        inputs: [
          { name: "b", type: "B" },
          { name: "a", type: "A" },
        ],
      },
    })
    expect(apiFingerprint(ab)).not.toBe(apiFingerprint(ba))
  })

  it("A18: swapping signature.outputs order perturbs the hash (positional contract)", () => {
    const ab = makeSymbol(base().id, {
      ...base(),
      signature: { ...sig(base()), outputs: ["A", "B"] },
    })
    const ba = makeSymbol(base().id, {
      ...base(),
      signature: { ...sig(base()), outputs: ["B", "A"] },
    })
    expect(apiFingerprint(ab)).not.toBe(apiFingerprint(ba))
  })

  it("A19: same-name decorators tie-break on line so their source order is preserved", () => {
    // Two `@ApiResponse` on adjacent lines. Reversing the (line-ordered) input should
    // give the same hash because the sort by (name, line) canonicalizes both permutations.
    const inSourceOrder = makeSymbol(base().id, {
      ...base(),
      decorators: [
        {
          name: "ApiResponse",
          raw: "ApiResponse(200)",
          arguments: ["200"],
          boundary: false,
          line: 10,
        },
        {
          name: "ApiResponse",
          raw: "ApiResponse(404)",
          arguments: ["404"],
          boundary: false,
          line: 11,
        },
      ],
    })
    const reversedInput = makeSymbol(base().id, {
      ...base(),
      decorators: [
        {
          name: "ApiResponse",
          raw: "ApiResponse(404)",
          arguments: ["404"],
          boundary: false,
          line: 11,
        },
        {
          name: "ApiResponse",
          raw: "ApiResponse(200)",
          arguments: ["200"],
          boundary: false,
          line: 10,
        },
      ],
    })
    expect(apiFingerprint(inSourceOrder)).toBe(apiFingerprint(reversedInput))

    // Swapping the LINE assignments (so the same-name decorators sit in a different source
    // order) is a real source change and must register.
    const linesSwapped = makeSymbol(base().id, {
      ...base(),
      decorators: [
        {
          name: "ApiResponse",
          raw: "ApiResponse(200)",
          arguments: ["200"],
          boundary: false,
          line: 11,
        },
        {
          name: "ApiResponse",
          raw: "ApiResponse(404)",
          arguments: ["404"],
          boundary: false,
          line: 10,
        },
      ],
    })
    expect(apiFingerprint(inSourceOrder)).not.toBe(apiFingerprint(linesSwapped))
  })
})
