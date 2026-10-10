import { describe, expect, it } from "vitest"
import {
  backslashSite,
  CoreError,
  DEFAULT_EXPORT_QNAME,
  isComponentId,
  isDefaultExportQname,
  isLanguageId,
  isSymbolId,
  makeComponentId,
  makeLanguageId,
  makeMemberQname,
  makeNestedQname,
  makeSymbolId,
  makeTopLevelQname,
  RESERVED_LANGUAGE_IDS,
  symbolIdFile,
  symbolIdSeparatorSite,
  toDocumentPath,
  toPosixRelative,
  trySymbolId,
} from "../src/index"
import { WORKSPACE_PATH_CASES } from "./fixtures/paths"

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

  it("answers the shared path table on the `symbolPath` side, with the stated reason", () => {
    for (const { path, symbolPath, why } of WORKSPACE_PATH_CASES) {
      const label = `${JSON.stringify(path)} (${why})`
      if (symbolPath.ok) {
        expect(makeSymbolId({ language: "ts", file: path, qualifiedName: "foo" }), label).toBe(
          `ts:${path}#foo`,
        )
        continue
      }
      let caught: unknown
      try {
        makeSymbolId({ language: "ts", file: path, qualifiedName: "foo" })
      } catch (err) {
        caught = err
      }
      expect(caught, label).toBeInstanceOf(CoreError)
      expect((caught as CoreError).code, label).toBe("non-posix-path")
      expect((caught as CoreError).message, label).toContain(symbolPath.reason)
    }
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

  it("keeps a private member's `#`, on either side", () => {
    expect(makeMemberQname(["C"], "#v", "instance")).toBe("C.#v")
    expect(makeMemberQname(["C"], "#v", "static")).toBe("C::#v")
  })

  it("refuses a private name as an owner", () => {
    expect(() => makeMemberQname(["#C"], "v", "instance")).toThrowError(
      expect.objectContaining({ code: "anonymous-symbol-id-attempted" }),
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

describe("qualified-name segment grammar", () => {
  const emptySegment = ["A.", ".A", "A..B", ".", "..", "::", "A::", "::B", "A.::B", "A::.B"]

  it("makeSymbolId rejects a qualified name with an empty segment, and says so", () => {
    for (const qualifiedName of emptySegment) {
      let caught: unknown
      try {
        makeSymbolId({ language: "ts", file: "src/a.ts", qualifiedName })
      } catch (err) {
        caught = err
      }
      expect(caught, qualifiedName).toBeInstanceOf(CoreError)
      expect((caught as CoreError).code, qualifiedName).toBe("anonymous-symbol-id-attempted")
      expect((caught as CoreError).message, qualifiedName).toContain("has an empty segment")
    }
  })

  it("isSymbolId and trySymbolId refuse them too", () => {
    for (const qualifiedName of emptySegment) {
      expect(isSymbolId(`ts:src/a.ts#${qualifiedName}`), qualifiedName).toBe(false)
      expect(
        trySymbolId({ language: "ts", file: "src/a.ts", qualifiedName }),
        qualifiedName,
      ).toBeNull()
    }
  })

  it("still accepts every shape the qname builders produce", () => {
    const accepted = [
      makeTopLevelQname("createInvoice"),
      makeMemberQname(["InvoiceService"], "create", "instance"),
      makeMemberQname(["InvoiceService"], "fromJson", "static"),
      makeMemberQname(["Billing", "Invoice"], "create", "instance"),
      makeNestedQname(["Billing", "Invoice", "create"]),
      makeTopLevelQname("_private"),
      makeTopLevelQname("$dollar"),
      makeTopLevelQname("a1"),
      DEFAULT_EXPORT_QNAME,
    ]
    for (const qualifiedName of accepted) {
      expect(makeSymbolId({ language: "ts", file: "src/a.ts", qualifiedName }), qualifiedName).toBe(
        `ts:src/a.ts#${qualifiedName}`,
      )
    }
  })
})

describe("toPosixRelative", () => {
  it("refuses a backslash instead of reading it as a separator", () => {
    expect(() => toPosixRelative("src/weird\\name.ts")).toThrowError(
      expect.objectContaining({ code: "non-posix-path" }),
    )
  })

  it("rejects absolute paths", () => {
    expect(() => toPosixRelative("C:/Users/foo/a.ts")).toThrowError(
      expect.objectContaining({ code: "non-posix-path" }),
    )
  })

  it("applies the id rule, not only the shared path rule", () => {
    for (const raw of ["src/a:b.ts", "src/a#b.ts", "."]) {
      expect(() => toPosixRelative(raw), raw).toThrowError(
        expect.objectContaining({ code: "non-posix-path" }),
      )
    }
  })
})

describe("toDocumentPath, backslashSite and symbolIdSeparatorSite", () => {
  it("admits the two characters the id rule refuses", () => {
    for (const raw of ["src/a:b.ts", "src/a#b.ts", "."]) {
      expect(toDocumentPath(raw), raw).toBe(raw)
      expect(() => toPosixRelative(raw), raw).toThrowError(
        expect.objectContaining({ code: "non-posix-path" }),
      )
    }
  })

  it("each describes the path as the thing its caller was building", () => {
    expect(() => toPosixRelative("../outside.ts")).toThrowError(/Symbol id file path/)
    expect(() => toDocumentPath("../outside.ts")).toThrowError(/^path /)
  })

  it("still refuses a path that is not workspace-relative at all", () => {
    for (const raw of ["C:\\Users\\foo\\a.ts", "../outside.ts", ""]) {
      expect(() => toDocumentPath(raw), raw).toThrowError(
        expect.objectContaining({ code: "non-posix-path" }),
      )
    }
  })

  it("normalizes the same way, so a skip entry and a Symbol id spell one path", () => {
    expect(toDocumentPath("src/cafe\u0301.ts")).toBe("src/caf\u00e9.ts")
    expect(toPosixRelative("src/cafe\u0301.ts")).toBe("src/caf\u00e9.ts")
  })

  it("refuses a backslash rather than rewriting it into a separator", () => {
    expect(() => toDocumentPath("src/weird\\name.ts")).toThrowError(
      expect.objectContaining({ code: "non-posix-path" }),
    )
    expect(() => toDocumentPath("src/weird\\name.ts")).toThrowError(/backslash/)
  })

  it("keeps two files that differ only by a backslash apart", () => {
    expect(() => toDocumentPath("a\\b.ts")).toThrowError()
    expect(toDocumentPath("a/b.ts")).toBe("a/b.ts")
  })

  it("refuses a native Windows path rather than converting it", () => {
    expect(() => toDocumentPath("C:\\Users\\foo\\a.ts")).toThrowError(/backslash/)
  })

  it("names the segment a backslash sits in, and the prefix that locates it", () => {
    expect(backslashSite("src/a.ts")).toBeNull()
    expect(backslashSite("src/weird\\name.ts")).toEqual({
      segment: "weird\\name.ts",
      prefix: "src/weird\\name.ts",
    })
    expect(backslashSite("src/v\\1/util.ts")).toEqual({ segment: "v\\1", prefix: "src/v\\1" })
    expect(backslashSite("a\\1/b\\2/c.ts")).toEqual({ segment: "a\\1", prefix: "a\\1" })
    expect(backslashSite("x/a\\1/y.ts")?.prefix).toBe("x/a\\1")
  })

  it("answers exactly what the shared rule refuses on that clause", () => {
    for (const raw of ["src/weird\\name.ts", "C:\\Users\\a.ts", "a\\1/b.ts"]) {
      expect(backslashSite(raw), raw).not.toBeNull()
      expect(() => toDocumentPath(raw), raw).toThrowError(/backslash/)
    }
    for (const raw of ["src/a.ts", "src/a:b.ts", "src/a#b.ts", "."]) {
      expect(backslashSite(raw), raw).toBeNull()
      expect(() => toDocumentPath(raw), raw).not.toThrowError(/backslash/)
    }
  })

  it("names the segment that holds them, and which, in id order", () => {
    expect(symbolIdSeparatorSite("src/a.ts")).toBeNull()
    expect(symbolIdSeparatorSite("src/a#b.ts")).toEqual({ segment: "a#b.ts", separators: ["#"] })
    expect(symbolIdSeparatorSite("src/a:b.ts")).toEqual({ segment: "a:b.ts", separators: [":"] })
    // The directory, not the file under it: `util.ts` is innocent and renaming it fixes nothing.
    expect(symbolIdSeparatorSite("src/v#1/util.ts")).toEqual({
      segment: "v#1",
      separators: ["#"],
    })
    expect(symbolIdSeparatorSite("src/a#b:c.ts")?.separators).toEqual([":", "#"])
  })

  it("answers null for a path that holds none but still cannot host an id", () => {
    expect(symbolIdSeparatorSite(".")).toBeNull()
    expect(() => toPosixRelative(".")).toThrowError()
  })

  it("is the same rule the id grammar enforces", () => {
    for (const raw of ["src/a:b.ts", "src/a#b.ts", "src/a#b:c.ts", "src/v#1/util.ts"]) {
      expect(symbolIdSeparatorSite(raw), raw).not.toBeNull()
      expect(() => toPosixRelative(raw), raw).toThrowError()
    }
  })
})

describe("reserved language namespaces", () => {
  it("refuses `slice` as a language token so a Symbol id cannot masquerade as a Slice id", () => {
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
    const rejected = [
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

  it("symbolIdFile answers with the path of a well-formed id", () => {
    expect(symbolIdFile("ts:src/a.ts#foo")).toBe("src/a.ts")
    expect(symbolIdFile("ts:src/nested/dir/a.ts#Cls.method")).toBe("src/nested/dir/a.ts")
    expect(symbolIdFile("ts:src/index.ts#<default>")).toBe("src/index.ts")
  })

  it("splits at the id's own `#` when the qualified name carries one too", () => {
    expect(isSymbolId("ts:src/a.ts#C.#v")).toBe(true)
    expect(symbolIdFile("ts:src/a.ts#C.#v")).toBe("src/a.ts")
    expect(symbolIdFile("ts:src/a.ts#C::#v")).toBe("src/a.ts")
  })

  it("symbolIdFile names no file for anything makeSymbolId would refuse", () => {
    const noFile = [
      "slice:ts:src/a.ts#foo",
      "ts:/abs/path.ts#foo",
      "ts:../../etc/passwd#foo",
      "ts:src\\a.ts#foo",
      "ts:./src/a.ts#foo",
      "ts:src/a.ts#3bad",
      "ts:src/a.ts#foo bar",
      "TS:src/a.ts#foo",
      "#foo",
      "src/a.ts",
    ]
    for (const value of noFile) {
      expect(symbolIdFile(value), value).toBeNull()
    }
  })

  it("isComponentId and isSymbolId never both accept the same string", () => {
    for (const value of ["ts:src/a.ts#foo", "billing", "not a valid id"]) {
      expect(isSymbolId(value) && isComponentId(value), value).toBe(false)
    }
  })
})

describe("makeLanguageId", () => {
  it("accepts the tokens the schema's LanguageId pattern allows", () => {
    for (const raw of ["ts", "tsx", "py", "go", "cs", "ex"]) {
      expect(makeLanguageId(raw)).toBe(raw)
    }
  })

  it("rejects a plugin manifest name", () => {
    expect(() => makeLanguageId("lang-typescript")).toThrow(CoreError)
  })

  it("rejects tokens outside the grammar", () => {
    for (const raw of ["", "TS", "1ts", "ts.x", "ts_x", "@scope/x"]) {
      expect(() => makeLanguageId(raw)).toThrow(CoreError)
    }
  })

  it("rejects a reserved token that would collide with another id namespace", () => {
    for (const reserved of RESERVED_LANGUAGE_IDS) {
      expect(() => makeLanguageId(reserved)).toThrow(CoreError)
    }
  })

  it("isLanguageId agrees with the constructor on every case", () => {
    for (const raw of ["ts", "py", "lang-typescript", "TS", "", "slice"]) {
      let constructed = true
      try {
        makeLanguageId(raw)
      } catch {
        constructed = false
      }
      expect(isLanguageId(raw)).toBe(constructed)
    }
  })
})
