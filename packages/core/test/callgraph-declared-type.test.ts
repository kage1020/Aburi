import { symbolId } from "@aburi/test-support"
import type { Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { makeCallSiteKey, makeSymbolCallKey } from "../src/call-site"
import { resolveCallGraph } from "../src/callgraph"
import { type ImportClause, importsOf, withCalls } from "./fixtures/callgraph"
import { makeSymbol } from "./fixtures/ir"

const CALLER = "ts:src/service.ts#UserService.byId"
const TARGET = "this.repo.find"

const repository = (file = "src/repo.ts", kind: IRSymbol["kind"] = "class") => [
  makeSymbol(`ts:${file}#UserRepository`, { kind }),
  makeSymbol(`ts:${file}#UserRepository.find`, { kind: "method" }),
]

const typed = (type: string | null, target = TARGET) =>
  new Map([[makeSymbolCallKey(CALLER, 3, target), type]])

function resolve(
  symbols: readonly IRSymbol[],
  options: { types?: ReadonlyMap<string, string | null>; imports?: ImportClause[] } = {},
) {
  return resolveCallGraph({
    symbols: [withCalls(CALLER, [{ target: TARGET, line: 3 }]), ...symbols],
    importsByFile: importsOf("src/service.ts", ...(options.imports ?? [])),
    receiverTypes: options.types ?? typed("UserRepository"),
  })
}

const FROM_REPO: ImportClause = { source: "./repo", symbols: ["UserRepository"] }

describe("a call through a receiver of a declared type", () => {
  it.each<[string, readonly IRSymbol[], ImportClause[], string]>([
    ["a class the file imports", repository(), [FROM_REPO], "UserRepository"],
    ["a class the file declares", repository("src/service.ts"), [], "UserRepository"],
    [
      "a class imported under another name",
      repository(),
      [{ source: "./repo", symbols: ["UserRepository as Repo"] }],
      "Repo",
    ],
    [
      "a class of a namespace the file imports",
      repository(),
      [{ source: "./repo", symbols: "*", namespaceBinding: "repos" }],
      "repos.UserRepository",
    ],
  ])("resolves to the member of %s, at medium confidence", (_case, symbols, imports, type) => {
    const result = resolve(symbols, { imports, types: typed(type) })
    const find = symbols[1]?.id
    expect(result.edges.map((edge) => [edge.to, edge.confidence])).toEqual([[find, "medium"]])
    expect(result.symbols[0]?.calls[0]?.resolved).toBe(find)
    expect(result.diagnostics).toEqual([])
  })

  it("reads the type's instance member, not a static one of the same name", () => {
    const result = resolve(
      [...repository(), makeSymbol("ts:src/repo.ts#UserRepository::find", { kind: "method" })],
      { imports: [FROM_REPO] },
    )
    expect(result.edges.map((edge) => edge.to)).toEqual(["ts:src/repo.ts#UserRepository.find"])
  })

  it.each<[string, readonly IRSymbol[], ReadonlyMap<string, string | null>]>([
    [
      "an interface, which a class implements elsewhere",
      repository("src/repo.ts", "interface"),
      typed("UserRepository"),
    ],
    [
      "a class that does not declare the member itself",
      [makeSymbol("ts:src/repo.ts#UserRepository", { kind: "class" })],
      typed("UserRepository"),
    ],
    ["a type the file does not bind", repository(), typed("OtherRepository")],
    ["a key whose calls named different types", repository(), typed(null)],
    ["no type at all", repository(), new Map()],
  ])("leaves the call unresolved and `dynamic` for %s", (_case, symbols, types) => {
    const result = resolve(symbols, { types, imports: [FROM_REPO] })
    expect(result.edges).toEqual([])
    expect(result.diagnostics.map((d) => d.bucket)).toEqual(["dynamic"])
  })

  it("defers to a language server's hint for the same call", () => {
    const result = resolveCallGraph({
      symbols: [withCalls(CALLER, [{ target: TARGET, line: 3 }]), ...repository()],
      importsByFile: importsOf("src/service.ts", FROM_REPO),
      receiverTypes: typed("UserRepository"),
      receiverHints: new Map([
        [
          makeCallSiteKey("src/service.ts", 3, TARGET),
          { kind: "this", targetSymbolId: symbolId("ts:src/repo.ts#UserRepository.find") },
        ],
      ]),
    })
    expect(result.edges.map((edge) => edge.confidence)).toEqual(["high"])
    expect(result.lspHintUsage.consumed).toBe(1)
  })

  it("leaves a call the earlier steps resolved as they resolved it", () => {
    const result = resolveCallGraph({
      symbols: [
        withCalls(CALLER, [{ target: "repo.find", line: 3 }]),
        ...repository(),
        makeSymbol("ts:src/service.ts#repo", { kind: "variable" }),
        makeSymbol("ts:src/service.ts#repo.find", { kind: "method" }),
      ],
      importsByFile: importsOf("src/service.ts", FROM_REPO),
      receiverTypes: typed("UserRepository", "repo.find"),
    })
    expect(result.edges.map((edge) => [edge.to, edge.confidence])).toEqual([
      ["ts:src/service.ts#repo.find", "high"],
    ])
  })
})
