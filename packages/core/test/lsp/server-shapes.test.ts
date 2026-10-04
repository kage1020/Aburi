import type { Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { makeCallSiteKey } from "../../src/call-site"
import { enrichWithLsp } from "../../src/lsp"
import { makeClassSymbol, makeEnrichmentInput, makeMethodSymbol } from "./fixtures/enrichment-ctx"
import { mockServerFactory } from "./fixtures/mock-server"

const HOVER_METHOD = "textDocument/hover"
const DOC_SYMBOL_METHOD = "textDocument/documentSymbol"

function staticMethod(
  file: string,
  className: string,
  methodName: string,
  line: number,
  calls: Array<{ target: string; line: number }> = [],
): IRSymbol {
  return {
    ...makeMethodSymbol(file, className, methodName, line, calls),
    id: `ts:${file}#${className}::${methodName}`,
    name: `${className}::${methodName}`,
  } as IRSymbol
}

/** The hover for `this.foo()` in `bar`, answered with `hover`. */
async function hoverOnce(hover: string, symbols: IRSymbol[], content: string) {
  const factory = mockServerFactory((_lang, client) => {
    client.installHandler(DOC_SYMBOL_METHOD, () => [])
    client.installHandler(HOVER_METHOD, () => ({ contents: { kind: "markdown", value: hover } }))
  })
  return enrichWithLsp(
    makeEnrichmentInput({ symbols, fileContents: { "src/a.ts": content }, serverFactory: factory }),
  )
}

const C_SOURCE = "class C {\n  foo() {}\n  bar() {\n    this.foo()\n  }\n}"
const C_SYMBOLS = () => [
  makeClassSymbol("src/a.ts", "C", 1),
  makeMethodSymbol("src/a.ts", "C", "foo", 2),
  makeMethodSymbol("src/a.ts", "C", "bar", 3, [{ target: "this.foo", line: 4 }]),
]

function inferredThrows(result: Awaited<ReturnType<typeof hoverOnce>>): string[] | undefined {
  return result.symbols.find((s) => s.id === "ts:src/a.ts#C.bar")?.signature?.inferredThrows
}

describe("LSP hover @throws", () => {
  it("reads the tags the server renders, with the tag in emphasis and an em dash", async () => {
    const hover = [
      "\n```typescript\n(method) C.foo(): void\n```\nLoads.",
      "*@throws* — {NotFoundError} when missing  ",
      "*@throws* — RangeError  ",
      "*@throws* — TypeError when not an integer",
    ].join("\n\n")
    expect(inferredThrows(await hoverOnce(hover, C_SYMBOLS(), C_SOURCE))).toEqual([
      "NotFoundError",
      "RangeError",
    ])
  })

  it("ends a rendered tag's text at the next rendered tag on the same line", async () => {
    const hover = "(method) C.foo(): void\n*@throws* — RangeError *@throws* — {A}"
    expect(inferredThrows(await hoverOnce(hover, C_SYMBOLS(), C_SOURCE))).toEqual([
      "A",
      "RangeError",
    ])
  })

  it("still reads the tag as written in source", async () => {
    const hover = "(method) C.foo(): void\n@throws {A}\n@throws B\n@throws C when"
    expect(inferredThrows(await hoverOnce(hover, C_SYMBOLS(), C_SOURCE))).toEqual(["A", "B"])
  })

  it("names nothing when the tag runs straight into a word", async () => {
    const hover = "(method) C.foo(): void\n@throwsX\n*@throws*Y"
    expect(inferredThrows(await hoverOnce(hover, C_SYMBOLS(), C_SOURCE))).toBeUndefined()
  })
})

describe("LSP hover owner class", () => {
  it("skips a generic owner's type arguments, nested ones included", async () => {
    for (const owner of ["C<T>", "C<Map<K, Array<V>>>"]) {
      const result = await hoverOnce(`(method) ${owner}.foo(): void`, C_SYMBOLS(), C_SOURCE)
      const hint = result.receiverHints.get(makeCallSiteKey("src/a.ts", 4, "this.foo"))
      expect(hint?.targetSymbolId, owner).toBe("ts:src/a.ts#C.foo")
    }
  })

  it("does not read a type argument of the member as the owner", async () => {
    const result = await hoverOnce("(method) C.foo<T>(x: D<T>.E): void", C_SYMBOLS(), C_SOURCE)
    const hint = result.receiverHints.get(makeCallSiteKey("src/a.ts", 4, "this.foo"))
    expect(hint?.targetSymbolId).toBe("ts:src/a.ts#C.foo")
  })
})

describe("LSP hover static members", () => {
  const SOURCE =
    "class F {\n  foo() {}\n  static foo() {}\n  static bar() {\n    this.foo()\n  }\n  baz() {\n    this.foo()\n  }\n}"
  const symbols = () => [
    makeClassSymbol("src/a.ts", "F", 1),
    makeMethodSymbol("src/a.ts", "F", "foo", 2),
    staticMethod("src/a.ts", "F", "foo", 3),
    staticMethod("src/a.ts", "F", "bar", 4, [{ target: "this.foo", line: 5 }]),
    makeMethodSymbol("src/a.ts", "F", "baz", 7, [{ target: "this.foo", line: 8 }]),
  ]

  it("resolves this. in a static member to the static, and in an instance one to the instance", async () => {
    const result = await hoverOnce("(method) F.foo(): void", symbols(), SOURCE)
    expect(
      result.receiverHints.get(makeCallSiteKey("src/a.ts", 5, "this.foo"))?.targetSymbolId,
    ).toBe("ts:src/a.ts#F::foo")
    expect(
      result.receiverHints.get(makeCallSiteKey("src/a.ts", 8, "this.foo"))?.targetSymbolId,
    ).toBe("ts:src/a.ts#F.foo")
  })

  it("falls back to the other spelling when the class has only one", async () => {
    const onlyStatic = symbols().filter((s) => s.id !== "ts:src/a.ts#F.foo")
    const a = await hoverOnce("(method) F.foo(): void", onlyStatic, SOURCE)
    expect(a.receiverHints.get(makeCallSiteKey("src/a.ts", 8, "this.foo"))?.targetSymbolId).toBe(
      "ts:src/a.ts#F::foo",
    )
    const onlyInstance = symbols().filter((s) => s.id !== "ts:src/a.ts#F::foo")
    const b = await hoverOnce("(method) F.foo(): void", onlyInstance, SOURCE)
    expect(b.receiverHints.get(makeCallSiteKey("src/a.ts", 5, "this.foo"))?.targetSymbolId).toBe(
      "ts:src/a.ts#F.foo",
    )
  })
})

describe("LSP documentSymbol matching", () => {
  const range = (sl: number, sc: number, el: number, ec: number) => ({
    start: { line: sl, character: sc },
    end: { line: el, character: ec },
  })

  async function columnsFor(symbols: IRSymbol[], content: string, entries: unknown[]) {
    const factory = mockServerFactory((_lang, client) => {
      client.installHandler(DOC_SYMBOL_METHOD, () => entries)
    })
    const result = await enrichWithLsp(
      makeEnrichmentInput({
        symbols,
        fileContents: { "src/a.ts": content },
        serverFactory: factory,
      }),
    )
    return Object.fromEntries(
      result.symbols.map((s) => [s.name, [s.source.startColumn, s.source.endColumn]]),
    )
  }

  it("matches a decorated declaration by the line its name is on and starts it after the decorators", async () => {
    const content = "@Dec()\n\t  export class D {}\n"
    const cls = makeClassSymbol("src/a.ts", "D", 2)
    expect(
      await columnsFor([cls], content, [
        { name: "D", kind: 5, range: range(0, 0, 1, 20), selectionRange: range(1, 16, 1, 17) },
      ]),
    ).toEqual({ D: [4, 21] })
  })

  it("takes the range's column when the range starts on the Symbol's line", async () => {
    const cls = makeClassSymbol("src/a.ts", "D", 1)
    expect(
      await columnsFor([cls], "  @Dec() class D {}\n", [
        { name: "D", kind: 5, range: range(0, 2, 0, 20), selectionRange: range(0, 15, 0, 16) },
      ]),
    ).toEqual({ D: [3, 21] })
  })

  it("matches nothing on a line outside the range-to-name span", async () => {
    const above = makeClassSymbol("src/a.ts", "D", 1)
    const below = { ...makeClassSymbol("src/a.ts", "D", 4), id: "ts:src/a.ts#D2" } as IRSymbol
    const inside = { ...makeClassSymbol("src/a.ts", "D", 3), id: "ts:src/a.ts#D3" } as IRSymbol
    const entry = {
      name: "D",
      kind: 5,
      range: range(1, 0, 3, 1),
      selectionRange: range(2, 6, 2, 7),
    }
    const factory = mockServerFactory((_lang, client) => {
      client.installHandler(DOC_SYMBOL_METHOD, () => [entry])
    })
    const result = await enrichWithLsp(
      makeEnrichmentInput({
        symbols: [above, below, inside],
        fileContents: { "src/a.ts": "\n@Dec\nclass D {\n}\n" },
        serverFactory: factory,
      }),
    )
    expect(result.symbols.map((s) => [s.id, s.source.startColumn])).toEqual([
      ["ts:src/a.ts#D", null],
      ["ts:src/a.ts#D2", null],
      ["ts:src/a.ts#D3", 1],
    ])
  })

  it("names a top-level `default` entry <default>, but not a member called default", async () => {
    const anon = {
      ...makeClassSymbol("src/a.ts", "<default>", 1),
      kind: "function",
    } as IRSymbol
    const member = makeMethodSymbol("src/a.ts", "K", "default", 3)
    const memberAsDefault = {
      ...makeMethodSymbol("src/a.ts", "K", "<default>", 4),
      id: "ts:src/a.ts#K.x",
    } as IRSymbol
    const entries = [
      { name: "default", kind: 12, range: range(0, 0, 0, 30), selectionRange: range(0, 0, 0, 30) },
      {
        name: "K",
        kind: 5,
        range: range(1, 0, 4, 1),
        selectionRange: range(1, 6, 1, 7),
        children: [
          {
            name: "default",
            kind: 6,
            range: range(2, 2, 2, 14),
            selectionRange: range(2, 2, 2, 9),
          },
          {
            name: "default",
            kind: 6,
            range: range(3, 2, 3, 14),
            selectionRange: range(3, 2, 3, 9),
          },
        ],
      },
    ]
    const content = "export default function () {}\nclass K {\n  default() {}\n  default() {}\n}\n"
    expect(await columnsFor([anon, member, memberAsDefault], content, entries)).toEqual({
      "<default>": [1, 31],
      "K.default": [3, 15],
      "K.<default>": [null, null],
    })
  })

  it("treats a SymbolInformation with no container as top level", async () => {
    const anon = { ...makeClassSymbol("src/a.ts", "<default>", 1), kind: "function" } as IRSymbol
    const location = (r: ReturnType<typeof range>) => ({
      uri: "file:///workspace/src/a.ts",
      range: r,
    })
    const content = "export default function () {}\n"
    expect(
      await columnsFor([anon], content, [
        { name: "default", kind: 12, location: location(range(0, 0, 0, 30)) },
      ]),
    ).toEqual({ "<default>": [1, 31] })
    expect(
      await columnsFor([anon], content, [
        { name: "default", kind: 12, containerName: "K", location: location(range(0, 0, 0, 30)) },
      ]),
    ).toEqual({ "<default>": [null, null] })
  })
})
