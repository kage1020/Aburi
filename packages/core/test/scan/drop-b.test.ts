import { type CandidateOverrides, makeCandidate } from "@aburi/test-support"
import type { SymbolCandidate } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { decideSymbolDrop } from "../../src"

const BODY = {}

function candidate(
  overrides: CandidateOverrides,
  mergedBodies?: readonly (object | null)[],
): SymbolCandidate {
  const built = makeCandidate(overrides)
  if (mergedBodies === undefined) return built
  return {
    ...built,
    mergedDeclarations: mergedBodies.map((bodyNode) => ({ bodyNode, fullNode: {} })),
  }
}

describe("decideSymbolDrop", () => {
  it.each<[string, SymbolCandidate, string]>([
    ["an interface", candidate({ kind: "interface", bodyNode: BODY }), "interface (data model)"],
    ["a type alias", candidate({ kind: "type", bodyNode: BODY }), "type alias"],
    ["a function with no body", candidate({ kind: "function", bodyNode: null }), "empty body"],
    ["a method with no body", candidate({ kind: "method", bodyNode: null }), "empty body"],
    [
      "a method none of whose declarations gave it a body",
      candidate({ kind: "method", bodyNode: null }, [null]),
      "empty body",
    ],
    [
      "a re-export",
      candidate({ kind: "function", bodyNode: BODY, derivedBy: ["export-keyword", "re-export"] }),
      "re-export",
    ],
  ])("drops %s", (_label, symbol, reason) => {
    expect(decideSymbolDrop(symbol)).toBe(reason)
  })

  it.each<[string, SymbolCandidate]>([
    ["a function with a body", candidate({ kind: "function", bodyNode: BODY })],
    [
      "a method whose only body came from a second declaration",
      candidate({ kind: "method", bodyNode: null }, [BODY]),
    ],
    ["a class, which needs no body node", candidate({ kind: "class", bodyNode: null })],
    [
      "an interface a boundary decorator marks as framework surface",
      candidate({
        kind: "interface",
        decorators: [
          { name: "Controller", raw: "@Controller()", arguments: [], boundary: true, line: 1 },
        ],
      }),
    ],
  ])("keeps %s", (_label, symbol) => {
    expect(decideSymbolDrop(symbol)).toBeNull()
  })
})
