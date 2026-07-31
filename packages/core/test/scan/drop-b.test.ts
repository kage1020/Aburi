import type { OpaqueAstNode, SymbolCandidate } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { decideSymbolDrop } from "../../src"
import { symbolId } from "../fixtures/ir"

function makeCandidate(
  overrides: Partial<SymbolCandidate<OpaqueAstNode>> = {},
): SymbolCandidate<OpaqueAstNode> {
  return {
    id: symbolId("ts:test.ts#Foo"),
    kind: "function",
    extKind: null,
    name: "Foo",
    visibility: "public",
    decorators: [],
    signature: null,
    source: { file: "test.ts", startLine: 1, endLine: 5, startColumn: null, endColumn: null },
    derivedBy: [],
    bodyNode: {} as OpaqueAstNode,
    fullNode: {} as OpaqueAstNode,
    ...overrides,
  }
}

describe("decideSymbolDrop — Category B rules", () => {
  it("drops an interface as 'interface (data model)'", () => {
    expect(decideSymbolDrop(makeCandidate({ kind: "interface" }))).toBe("interface (data model)")
  })

  it("drops a type alias as 'type alias'", () => {
    expect(decideSymbolDrop(makeCandidate({ kind: "type" }))).toBe("type alias")
  })

  it("drops a function with no body as 'empty body'", () => {
    expect(decideSymbolDrop(makeCandidate({ kind: "function", bodyNode: null }))).toBe("empty body")
  })

  it("drops a method with no body as 'empty body'", () => {
    expect(decideSymbolDrop(makeCandidate({ kind: "method", bodyNode: null }))).toBe("empty body")
  })

  it("drops a re-export symbol via the language-plugin derivedBy marker", () => {
    expect(decideSymbolDrop(makeCandidate({ derivedBy: ["export-keyword", "re-export"] }))).toBe(
      "re-export",
    )
  })

  it("returns null for a regular function with a body", () => {
    expect(decideSymbolDrop(makeCandidate())).toBeNull()
  })

  it("keeps an interface that carries a boundary decorator — framework surface overrides shape drop", () => {
    const withBoundary = makeCandidate({
      kind: "interface",
      decorators: [
        { name: "Controller", raw: "@Controller()", arguments: [], boundary: true, line: 1 },
      ],
    })
    expect(decideSymbolDrop(withBoundary)).toBeNull()
  })
})
