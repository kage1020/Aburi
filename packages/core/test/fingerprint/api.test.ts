import type { Symbol as IRSymbol, Signature } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { makeLanguageId } from "../../src/id"
import { apiFingerprint } from "../../src/index"
import { makeSymbol } from "../fixtures/ir"

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

describe("apiFingerprint — invariance", () => {
  it("renaming signature.inputs[].name does not change the hash", () => {
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

  it("mutating rules and effects does not change the hash", () => {
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

  it("swapping decorator declaration order does not change the hash", () => {
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

  it("changing the class scope but keeping the leaf does not change the hash", () => {
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

  it("changing language does not change the api hash (language is not part of the input)", () => {
    const asTs = makeSymbol(base().id, { ...base(), language: makeLanguageId("ts") })
    const asTsx = makeSymbol(base().id, { ...base(), language: makeLanguageId("tsx") })
    expect(apiFingerprint(asTs)).toBe(apiFingerprint(asTsx))
  })

  it("spelling a rest marker into signature.inputs[].name does not change the hash", () => {
    const withInputs = (inputs: Signature["inputs"]) =>
      makeSymbol(base().id, { ...base(), signature: { ...sig(base()), inputs } })
    expect(apiFingerprint(withInputs([{ name: "...ids", type: "string[]" }]))).toBe(
      apiFingerprint(withInputs([{ name: "ids", type: "string[]" }])),
    )
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

  it("visibility change perturbs the hash", () => {
    const sym = makeSymbol(base().id, { ...base(), visibility: "private" })
    expect(apiFingerprint(sym)).not.toBe(beforeFp)
  })

  it("adding a signature output perturbs the hash", () => {
    const sym = makeSymbol(base().id, {
      ...base(),
      signature: { ...sig(base()), outputs: ["Promise<Invoice>", "Metadata"] },
    })
    expect(apiFingerprint(sym)).not.toBe(beforeFp)
  })

  it("adding a throws entry perturbs the hash", () => {
    const sym = makeSymbol(base().id, {
      ...base(),
      signature: { ...sig(base()), throws: ["CreditLimitExceeded", "AuditFailed"] },
    })
    expect(apiFingerprint(sym)).not.toBe(beforeFp)
  })

  it("adding a decorator perturbs the hash", () => {
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

  it("changing a decorator argument perturbs the hash", () => {
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

  it("toggling async perturbs the hash", () => {
    const sync = makeSymbol(base().id, {
      ...base(),
      signature: { ...sig(base()), async: false },
    })
    expect(apiFingerprint(sync)).not.toBe(beforeFp)
  })

  it("kind change perturbs the hash", () => {
    const sym = makeSymbol(base().id, { ...base(), kind: "function" })
    expect(apiFingerprint(sym)).not.toBe(beforeFp)
  })

  it("extKind change perturbs the hash", () => {
    const sym = makeSymbol(base().id, { ...base(), extKind: "framework:nestjs:controller" })
    expect(apiFingerprint(sym)).not.toBe(beforeFp)
  })

  it("shortName change perturbs the hash", () => {
    const sym = makeSymbol(base().id, { ...base(), name: "InvoiceService.updateInvoice" })
    expect(apiFingerprint(sym)).not.toBe(beforeFp)
  })

  it("toggling generator perturbs the hash", () => {
    const gen = makeSymbol(base().id, {
      ...base(),
      signature: { ...sig(base()), generator: true },
    })
    expect(apiFingerprint(gen)).not.toBe(beforeFp)
  })

  it("adding a typeParameter perturbs the hash", () => {
    const withParam = makeSymbol(base().id, {
      ...base(),
      signature: { ...sig(base()), typeParameters: ["T"] },
    })
    expect(apiFingerprint(withParam)).not.toBe(beforeFp)
  })

  it("changing a typeParameter constraint perturbs the hash", () => {
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

  it("toggling Decorator.boundary perturbs the hash", () => {
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

  it("toggling signature.inputs[].optional perturbs the hash", () => {
    const optional = makeSymbol(base().id, {
      ...base(),
      signature: {
        ...sig(base()),
        inputs: [{ name: "dto", type: "CreateInvoiceDto", optional: true }],
      },
    })
    expect(apiFingerprint(optional)).not.toBe(beforeFp)
  })

  it("toggling signature.inputs[].rest perturbs the hash", () => {
    const rest = makeSymbol(base().id, {
      ...base(),
      signature: {
        ...sig(base()),
        inputs: [{ name: "dto", type: "CreateInvoiceDto", rest: true }],
      },
    })
    expect(apiFingerprint(rest)).not.toBe(beforeFp)
  })

  it("optional and rest are two contracts, not one", () => {
    const withForm = (form: { optional?: true; rest?: true }) =>
      makeSymbol(base().id, {
        ...base(),
        signature: { ...sig(base()), inputs: [{ name: "dto", type: "CreateInvoiceDto", ...form }] },
      })
    expect(apiFingerprint(withForm({ optional: true }))).not.toBe(
      apiFingerprint(withForm({ rest: true })),
    )
  })
})

describe("apiFingerprint — order preservation", () => {
  it("swapping signature.inputs order perturbs the hash (positional contract)", () => {
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

  it("swapping signature.outputs order perturbs the hash (positional contract)", () => {
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

  it("same-name decorators tie-break on line so their source order is preserved", () => {
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
