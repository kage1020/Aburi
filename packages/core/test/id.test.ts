import { describe, expect, it } from "vitest"
import {
  backslashSite,
  CoreError,
  type CoreErrorCode,
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
  type SymbolIdParts,
  symbolIdFile,
  symbolIdSeparatorSite,
  toDocumentPath,
  toPosixRelative,
  trySymbolId,
} from "../src/index"
import { WORKSPACE_PATH_CASES } from "./fixtures/paths"

function parts(overrides: Partial<SymbolIdParts>): SymbolIdParts {
  return { language: "ts", file: "src/a.ts", qualifiedName: "foo", ...overrides }
}

describe("makeSymbolId", () => {
  it("composes <language>:<file>#<qualified name>", () => {
    const id = makeSymbolId(parts({ file: "apps/billing/src/create.ts", qualifiedName: "create" }))
    expect(id).toBe("ts:apps/billing/src/create.ts#create")
  })

  it("accepts the <default> sentinel as the qualified name of a default export", () => {
    expect(makeSymbolId(parts({ qualifiedName: DEFAULT_EXPORT_QNAME }))).toBe(
      "ts:src/a.ts#<default>",
    )
    expect(isDefaultExportQname(DEFAULT_EXPORT_QNAME)).toBe(true)
    expect(isDefaultExportQname("default")).toBe(false)
  })

  it("accepts a language token that merely starts with a reserved one", () => {
    expect(makeSymbolId(parts({ language: "slicer" }))).toBe("slicer:src/a.ts#foo")
  })

  it.each<[string, Partial<SymbolIdParts>, CoreErrorCode]>([
    [
      "a position-dependent anonymous name",
      { qualifiedName: "<anon@L42>" },
      "anonymous-symbol-id-attempted",
    ],
    ["an empty qualified name", { qualifiedName: "" }, "anonymous-symbol-id-attempted"],
    [
      "a qualified name that is not an identifier",
      { qualifiedName: "a b" },
      "anonymous-symbol-id-attempted",
    ],
    ["a language that is not a lowercase identifier", { language: "TS" }, "invalid-language-id"],
    [
      "the reserved `slice` language, which would pass for a Slice id",
      { language: "slice" },
      "invalid-language-id",
    ],
  ])("refuses %s, and trySymbolId answers null", (_what, overrides, code) => {
    expect(() => makeSymbolId(parts(overrides))).toThrowError(expect.objectContaining({ code }))
    expect(trySymbolId(parts(overrides))).toBeNull()
  })

  it.each([
    "A.",
    ".A",
    "A..B",
    ".",
    "..",
    "::",
    "A::",
    "::B",
    "A.::B",
    "A::.B",
  ])("refuses %j for its empty segment, and no guard accepts it", (qualifiedName) => {
    expect(() => makeSymbolId(parts({ qualifiedName }))).toThrowError(
      expect.objectContaining({
        code: "anonymous-symbol-id-attempted",
        message: expect.stringContaining("has an empty segment"),
      }),
    )
    expect(trySymbolId(parts({ qualifiedName }))).toBeNull()
    expect(isSymbolId(`ts:src/a.ts#${qualifiedName}`)).toBe(false)
  })

  it("accepts every shape the qname builders produce", () => {
    const built = [
      makeTopLevelQname("createInvoice"),
      makeMemberQname(["InvoiceService"], "create", "instance"),
      makeMemberQname(["InvoiceService"], "fromJson", "static"),
      makeNestedQname(["Billing", "Invoice", "create"]),
      makeTopLevelQname("_private"),
      makeTopLevelQname("$dollar"),
      makeTopLevelQname("a1"),
      DEFAULT_EXPORT_QNAME,
    ]
    for (const qualifiedName of built) {
      expect(makeSymbolId(parts({ qualifiedName })), qualifiedName).toBe(
        `ts:src/a.ts#${qualifiedName}`,
      )
    }
  })
})

describe("the shared path table", () => {
  it.each(WORKSPACE_PATH_CASES)("$path as the file of a Symbol id ($why)", ({
    path,
    symbolPath,
  }) => {
    if (symbolPath.ok) {
      expect(makeSymbolId(parts({ file: path }))).toBe(`ts:${path}#foo`)
      expect(trySymbolId(parts({ file: path }))).toBe(`ts:${path}#foo`)
      expect(toPosixRelative(path)).toBe(path)
      return
    }
    const refusal = expect.objectContaining({
      code: "non-posix-path",
      message: expect.stringContaining(symbolPath.reason),
    })
    expect(() => makeSymbolId(parts({ file: path }))).toThrowError(refusal)
    expect(() => toPosixRelative(path)).toThrowError(refusal)
    expect(trySymbolId(parts({ file: path }))).toBeNull()
  })

  it.each(WORKSPACE_PATH_CASES)("$path as a Document path ($why)", ({ path, root }) => {
    if (root.ok) {
      expect(toDocumentPath(path)).toBe(path)
      return
    }
    expect(() => toDocumentPath(path)).toThrowError(
      expect.objectContaining({
        code: "non-posix-path",
        message: expect.stringContaining(root.reason),
      }),
    )
  })

  it("describes the path as the thing its caller was building", () => {
    expect(() => toPosixRelative("../outside.ts")).toThrowError(/^Symbol id file path /)
    expect(() => toDocumentPath("../outside.ts")).toThrowError(/^path /)
  })

  it("normalizes to NFC either way, so a skip entry and a Symbol id spell one path", () => {
    expect(toDocumentPath("src/cafe\u0301.ts")).toBe("src/caf\u00e9.ts")
    expect(toPosixRelative("src/cafe\u0301.ts")).toBe("src/caf\u00e9.ts")
    expect(makeSymbolId(parts({ file: "src/cafe\u0301.ts" }))).toBe("ts:src/caf\u00e9.ts#foo")
  })
})

describe("backslashSite", () => {
  it.each<[string, ReturnType<typeof backslashSite>]>([
    ["src/a.ts", null],
    ["src/a:b.ts", null],
    [".", null],
    ["src/weird\\name.ts", { segment: "weird\\name.ts", prefix: "src/weird\\name.ts" }],
    ["src/v\\1/util.ts", { segment: "v\\1", prefix: "src/v\\1" }],
    ["a\\1/b\\2/c.ts", { segment: "a\\1", prefix: "a\\1" }],
  ])("answers %j with the first segment holding one and the prefix up to it", (path, site) => {
    expect(backslashSite(path)).toEqual(site)
  })
})

describe("symbolIdSeparatorSite", () => {
  it.each<[string, ReturnType<typeof symbolIdSeparatorSite>]>([
    ["src/a.ts", null],
    [".", null],
    ["src/a#b.ts", { segment: "a#b.ts", separators: ["#"] }],
    ["src/a:b.ts", { segment: "a:b.ts", separators: [":"] }],
    ["src/a#b:c.ts", { segment: "a#b:c.ts", separators: [":", "#"] }],
    ["src/v#1/util.ts", { segment: "v#1", separators: ["#"] }],
  ])("answers %j with the segment holding them, in id order", (path, site) => {
    expect(symbolIdSeparatorSite(path)).toEqual(site)
  })
})

describe("qualified-name builders", () => {
  it.each<[readonly string[], string, "instance" | "static", string]>([
    [["InvoiceService"], "createInvoice", "instance", "InvoiceService.createInvoice"],
    [["InvoiceService"], "fromJson", "static", "InvoiceService::fromJson"],
    [["Billing", "Invoice"], "create", "instance", "Billing.Invoice.create"],
    [["C"], "#v", "instance", "C.#v"],
    [["C"], "#v", "static", "C::#v"],
  ])("makeMemberQname(%j, %j, %s) is %j", (owners, member, kind, qname) => {
    expect(makeMemberQname(owners, member, kind)).toBe(qname)
  })

  it("makeTopLevelQname returns the identifier and makeNestedQname joins with '.'", () => {
    expect(makeTopLevelQname("createInvoice")).toBe("createInvoice")
    expect(makeNestedQname(["Billing", "Invoice", "create"])).toBe("Billing.Invoice.create")
  })

  it.each<[string, () => string]>([
    ["a private name as an owner", () => makeMemberQname(["#C"], "v", "instance")],
    ["an empty owner chain", () => makeMemberQname([], "createInvoice", "instance")],
    ["an owner that is not an identifier", () => makeMemberQname(["With Space"], "x", "instance")],
    ["a top-level name that is not an identifier", () => makeTopLevelQname("a b")],
    ["a nested name with no segment", () => makeNestedQname([])],
    ["a nested segment that is not an identifier", () => makeNestedQname(["a", "b c"])],
  ])("refuse %s", (_what, build) => {
    expect(build).toThrowError(expect.objectContaining({ code: "anonymous-symbol-id-attempted" }))
  })
})

describe("isSymbolId and symbolIdFile", () => {
  it.each([
    ["ts:src/a.ts#foo", "src/a.ts"],
    ["ts:src/nested/dir/a.ts#Cls.method", "src/nested/dir/a.ts"],
    ["ts:src/a.ts#Cls::fromJson", "src/a.ts"],
    ["ts:src/index.ts#<default>", "src/index.ts"],
    ["ts:src/a.ts#C.#v", "src/a.ts"],
    ["ts:src/a.ts#C::#v", "src/a.ts"],
  ])("accept %j, whose file is %j", (id, file) => {
    expect(isSymbolId(id)).toBe(true)
    expect(symbolIdFile(id)).toBe(file)
  })

  it.each([
    "billing",
    "src/a.ts",
    "ts:src/a.ts",
    "#foo",
    "TS:src/a.ts#foo",
    "slice:ts:src/a.ts#foo",
    "ts:src\\a.ts#foo",
    "ts:/abs/path.ts#foo",
    "ts:../../etc/passwd#foo",
    "ts:./src/a.ts#foo",
    "ts:src/a#b.ts#foo",
    "ts:src/a.ts#3bad",
    "ts:src/a.ts#foo bar",
    "ts:src/cafe\u0301.ts#foo",
  ])("refuse %j, which makeSymbolId would not have built", (value) => {
    expect(isSymbolId(value)).toBe(false)
    expect(symbolIdFile(value)).toBeNull()
  })
})

describe("makeComponentId and isComponentId", () => {
  it.each([
    "billing",
    "billing-api-v2",
    "billing-2",
    "3d-force-graph",
    "7zip-bin",
  ])("accept %j", (id) => {
    expect(makeComponentId(id)).toBe(id)
    expect(isComponentId(id)).toBe(true)
  })

  it.each([
    "",
    "Billing",
    "billing_api",
    "billing-",
    "-billing",
    "billing--api",
    "ts:src/a.ts#foo",
  ])("refuse %j", (id) => {
    expect(() => makeComponentId(id)).toThrowError(
      expect.objectContaining({ code: "invalid-component-id" }),
    )
    expect(isComponentId(id)).toBe(false)
  })
})

describe("makeLanguageId and isLanguageId", () => {
  it.each(["ts", "tsx", "py", "go", "cs", "ex"])("accept %j", (raw) => {
    expect(makeLanguageId(raw)).toBe(raw)
    expect(isLanguageId(raw)).toBe(true)
  })

  it.each([
    "lang-typescript",
    "",
    "TS",
    "1ts",
    "ts.x",
    "ts_x",
    "@scope/x",
    ...RESERVED_LANGUAGE_IDS,
  ])("refuse %j", (raw) => {
    expect(() => makeLanguageId(raw)).toThrow(CoreError)
    expect(() => makeLanguageId(raw)).toThrowError(
      expect.objectContaining({ code: "invalid-language-id" }),
    )
    expect(isLanguageId(raw)).toBe(false)
  })
})
