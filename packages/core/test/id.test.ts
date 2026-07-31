import { describe, expect, it } from "vitest"
import {
  CoreError,
  DEFAULT_EXPORT_QNAME,
  isComponentId,
  isDefaultExportQname,
  isSymbolId,
  makeComponentId,
  makeMemberQname,
  makeNestedQname,
  makeSymbolId,
  makeTopLevelQname,
  toPosixRelative,
  trySymbolId,
} from "../src/index"

describe("makeSymbolId", () => {
  it("composes lang:file#qname for a top-level function", () => {
    expect(
      makeSymbolId({
        language: "ts",
        file: "apps/billing/src/createInvoice.ts",
        qualifiedName: "createInvoice",
      }),
    ).toBe("ts:apps/billing/src/createInvoice.ts#createInvoice")
  })

  it("accepts <default> as the lone qualified name reserved for default exports", () => {
    const id = makeSymbolId({
      language: "ts",
      file: "src/index.ts",
      qualifiedName: DEFAULT_EXPORT_QNAME,
    })
    expect(id).toBe("ts:src/index.ts#<default>")
    expect(isDefaultExportQname(DEFAULT_EXPORT_QNAME)).toBe(true)
  })

  it("rejects anonymous position-dependent qnames (<anon@L42> family)", () => {
    let caught: unknown
    try {
      makeSymbolId({ language: "ts", file: "src/a.ts", qualifiedName: "<anon@L42>" })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(CoreError)
    expect((caught as CoreError).code).toBe("anonymous-symbol-id-attempted")
  })

  it("rejects empty qualified names", () => {
    expect(() =>
      makeSymbolId({ language: "ts", file: "src/a.ts", qualifiedName: "" }),
    ).toThrowError(expect.objectContaining({ code: "anonymous-symbol-id-attempted" }))
  })

  it("rejects backslash paths", () => {
    expect(() =>
      makeSymbolId({ language: "ts", file: "src\\a.ts", qualifiedName: "foo" }),
    ).toThrowError(expect.objectContaining({ code: "non-posix-path" }))
  })

  it("rejects absolute POSIX paths", () => {
    expect(() =>
      makeSymbolId({ language: "ts", file: "/abs/a.ts", qualifiedName: "foo" }),
    ).toThrowError(expect.objectContaining({ code: "non-posix-path" }))
  })

  it("rejects Windows drive-letter paths", () => {
    expect(() =>
      makeSymbolId({ language: "ts", file: "C:/abs/a.ts", qualifiedName: "foo" }),
    ).toThrowError(expect.objectContaining({ code: "non-posix-path" }))
  })

  it("rejects parent-ascending paths", () => {
    expect(() =>
      makeSymbolId({ language: "ts", file: "../escape/a.ts", qualifiedName: "foo" }),
    ).toThrowError(expect.objectContaining({ code: "non-posix-path" }))
  })

  it("rejects language ids that are not lowercase-ASCII identifiers", () => {
    expect(() =>
      makeSymbolId({ language: "TS", file: "src/a.ts", qualifiedName: "foo" }),
    ).toThrowError(expect.objectContaining({ code: "invalid-language-id" }))
  })
})

describe("makeMemberQname", () => {
  it("joins instance methods with '.'", () => {
    expect(makeMemberQname(["InvoiceService"], "createInvoice", "instance")).toBe(
      "InvoiceService.createInvoice",
    )
  })

  it("joins static members with '::'", () => {
    expect(makeMemberQname(["InvoiceService"], "fromJson", "static")).toBe(
      "InvoiceService::fromJson",
    )
  })

  it("supports nested namespace.class.method chains", () => {
    expect(makeMemberQname(["Billing", "Invoice"], "create", "instance")).toBe(
      "Billing.Invoice.create",
    )
  })

  it("rejects an empty owner chain", () => {
    expect(() => makeMemberQname([], "createInvoice", "instance")).toThrowError(
      expect.objectContaining({ code: "anonymous-symbol-id-attempted" }),
    )
  })

  it("rejects identifier-violating segments", () => {
    expect(() => makeMemberQname(["With Space"], "x", "instance")).toThrowError(
      expect.objectContaining({ code: "anonymous-symbol-id-attempted" }),
    )
  })
})

describe("makeTopLevelQname / makeNestedQname", () => {
  it("returns the identifier verbatim for top-level constructs", () => {
    expect(makeTopLevelQname("createInvoice")).toBe("createInvoice")
  })

  it("joins nested qname segments with '.'", () => {
    expect(makeNestedQname(["Billing", "Invoice", "create"])).toBe("Billing.Invoice.create")
  })

  it("rejects a 0-segment nested qname", () => {
    expect(() => makeNestedQname([])).toThrowError(
      expect.objectContaining({ code: "anonymous-symbol-id-attempted" }),
    )
  })
})

describe("toPosixRelative", () => {
  it("normalizes backslashes into forward slashes", () => {
    expect(toPosixRelative("src\\a\\b.ts")).toBe("src/a/b.ts")
  })

  it("rejects absolute paths even after normalization", () => {
    expect(() => toPosixRelative("C:\\Users\\foo\\a.ts")).toThrowError(
      expect.objectContaining({ code: "non-posix-path" }),
    )
  })
})

describe("reserved language namespaces", () => {
  it("refuses `slice` as a language token so a Symbol id cannot masquerade as a Slice id", () => {
    // Slice ids are "slice:" + the anchor Symbol id (slice-view.md §7.1). A `slice` language
    // plugin would mint Symbol ids in that same namespace, and deriving a Slice id from one
    // would produce "slice:slice:...". The brand keeps the two apart inside typed code; this
    // keeps them apart on the wire, where the brand is erased.
    expect(() =>
      makeSymbolId({ language: "slice", file: "src/a.ts", qualifiedName: "foo" }),
    ).toThrowError(expect.objectContaining({ code: "invalid-language-id" }))
  })

  it("still accepts language tokens that merely start with the reserved one", () => {
    expect(makeSymbolId({ language: "slicer", file: "src/a.ts", qualifiedName: "foo" })).toBe(
      "slicer:src/a.ts#foo",
    )
  })
})

describe("trySymbolId", () => {
  it("returns the same id makeSymbolId would for valid parts", () => {
    const parts = { language: "ts", file: "src/a.ts", qualifiedName: "Cls.method" }
    expect(trySymbolId(parts)).toBe(makeSymbolId(parts))
  })

  it("answers null where makeSymbolId throws", () => {
    // The call-graph resolver and the LSP enrichment pass assemble speculative callee ids
    // and then test them for existence. Throwing there would turn "no such callee" into a
    // scan abort, so every rejection makeSymbolId reports has to be available as a null.
    expect(trySymbolId({ language: "TS", file: "src/a.ts", qualifiedName: "foo" })).toBeNull()
    expect(trySymbolId({ language: "slice", file: "src/a.ts", qualifiedName: "foo" })).toBeNull()
    expect(trySymbolId({ language: "ts", file: "src\\a.ts", qualifiedName: "foo" })).toBeNull()
    expect(trySymbolId({ language: "ts", file: "/abs/a.ts", qualifiedName: "foo" })).toBeNull()
    expect(trySymbolId({ language: "ts", file: "../a.ts", qualifiedName: "foo" })).toBeNull()
    expect(trySymbolId({ language: "ts", file: "src/a.ts", qualifiedName: "" })).toBeNull()
    expect(trySymbolId({ language: "ts", file: "src/a.ts", qualifiedName: "<anon@L1>" })).toBeNull()
    expect(trySymbolId({ language: "ts", file: "src/a.ts", qualifiedName: "a b" })).toBeNull()
  })
})

describe("makeComponentId", () => {
  it("accepts the kebab-case shape the IR schema requires", () => {
    expect(makeComponentId("billing")).toBe("billing")
    expect(makeComponentId("billing-api-v2")).toBe("billing-api-v2")
  })

  it("accepts a digit-leading segment, because npm package names have them", () => {
    // Component ids are derived by kebab-casing a package or directory name
    // (component-detect.md §4.1). `3d-force-graph` and `7zip-bin` are real packages; a
    // letter-first rule would make that derivation partial for no benefit.
    expect(makeComponentId("3d-force-graph")).toBe("3d-force-graph")
    expect(makeComponentId("7zip-bin")).toBe("7zip-bin")
    expect(makeComponentId("billing-2")).toBe("billing-2")
  })

  it("rejects ids the schema would reject, at the point of construction", () => {
    for (const bad of ["", "Billing", "billing_api", "billing-", "-billing", "billing--api"]) {
      expect(() => makeComponentId(bad), `expected "${bad}" to be rejected`).toThrowError(
        expect.objectContaining({ code: "invalid-component-id" }),
      )
    }
  })
})

/** Mirror of the module-private split, so the two directions can be compared in one test. */
function splitForTest(value: string): { language: string; file: string; qualifiedName: string } {
  const colon = value.indexOf(":")
  const hash = value.indexOf("#", colon + 1)
  return {
    language: value.slice(0, colon),
    file: value.slice(colon + 1, hash),
    qualifiedName: value.slice(hash + 1),
  }
}

describe("id guards", () => {
  it("isSymbolId accepts exactly what makeSymbolId would have built", () => {
    expect(isSymbolId("ts:src/a.ts#foo")).toBe(true)
    expect(isSymbolId("ts:src/a.ts#Cls.method")).toBe(true)
    expect(isSymbolId("ts:src/a.ts#Cls::fromJson")).toBe(true)
    expect(isSymbolId("ts:src/index.ts#<default>")).toBe(true)
    expect(isSymbolId("billing")).toBe(false)
    expect(isSymbolId("ts:src/a.ts")).toBe(false)
    expect(isSymbolId("ts:src\\a.ts#foo")).toBe(false)
  })

  it("isSymbolId refuses everything makeSymbolId refuses", () => {
    // The predicate and the constructor have to answer the same question, or a string the
    // constructor would never produce narrows to `SymbolId` anyway. A silhouette-matching
    // regex accepted all five of these.
    const rejected = [
      // A well-formed SliceId. `SliceId` is assignable to `string`, so this call compiles;
      // narrowing it would forge a SymbolId out of an id from another namespace.
      "slice:ts:src/a.ts#foo",
      "ts:/abs/path.ts#foo",
      "ts:../../etc/passwd#foo",
      "ts:src/a.ts#foo bar baz",
      "ts:src/a#b.ts#foo",
    ]
    for (const value of rejected) {
      expect(isSymbolId(value), value).toBe(false)
      expect(() => makeSymbolId(splitForTest(value)), value).toThrowError(CoreError)
    }
  })

  it("isComponentId and isSymbolId never both accept the same string", () => {
    // What the two guards are for: `dependencies[].from`/`.to` hold either kind, and the
    // kind is recovered from the shape alone (ir-schema.md §11).
    for (const value of ["ts:src/a.ts#foo", "billing", "not a valid id"]) {
      expect(isSymbolId(value) && isComponentId(value), value).toBe(false)
    }
  })
})
