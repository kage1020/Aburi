import { describe, expect, it } from "vitest"
import {
  CoreError,
  DEFAULT_EXPORT_QNAME,
  isDefaultExportQname,
  makeMemberQname,
  makeNestedQname,
  makeSymbolId,
  makeTopLevelQname,
  toPosixRelative,
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
