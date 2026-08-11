import type { SymbolCandidate } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { Node } from "web-tree-sitter"
import { extractSymbols, parseTypescriptFile } from "../src/index"
import { makeExtractionCtx, requireTree } from "./fixtures/ctx"

/**
 * The leading JSDoc block and the decorator list are both read as a *run of siblings
 * immediately before a declaration*. Reading them from the node backwards rather than by
 * searching the parent's child list for the node is what keeps a file of N declarations
 * from costing O(N) per declaration — but the two readings only agree while the run's
 * boundaries are the same, so these pin the boundaries rather than the cost.
 *
 * A run is observable in two places:
 *   - the comment run through `signature.throws`, which unions the `@throws` tags of the
 *     whole leading block (signature.ts `readThrows`);
 *   - the decorator run through `decorators[]`.
 */

async function symbolsOf(source: string): Promise<SymbolCandidate<Node>[]> {
  const result = await parseTypescriptFile({ path: "src/a.ts", content: source })
  return extractSymbols(requireTree(result.tree), makeExtractionCtx("src/a.ts", source))
}

function byId(symbols: SymbolCandidate<Node>[], suffix: string): SymbolCandidate<Node> {
  const match = symbols.find((s) => s.id.endsWith(suffix))
  if (match === undefined) {
    throw new Error(
      `no symbol with id ending in "${suffix}" (have: ${symbols.map((s) => s.id).join(", ")})`,
    )
  }
  return match
}

describe("leading comment run", () => {
  it("collects every comment in the run, not only the one touching the declaration", async () => {
    const symbols = await symbolsOf(
      ["/** @throws OuterError */", "/** @throws InnerError */", "function f() {}", ""].join("\n"),
    )
    expect(byId(symbols, "#f").signature?.throws).toEqual(["InnerError", "OuterError"])
  })

  it("stops at the first non-comment sibling", async () => {
    // The comment belongs to `before`, not to `f`, and a run that walked past `before`
    // would hand `f` a @throws tag written about someone else.
    const symbols = await symbolsOf(
      ["/** @throws StrayError */", "function before() {}", "function f() {}", ""].join("\n"),
    )
    expect(byId(symbols, "#f").signature?.throws).toEqual([])
    expect(byId(symbols, "#before").signature?.throws).toEqual(["StrayError"])
  })

  it("reads nothing for the first statement in a file", async () => {
    const symbols = await symbolsOf("function f() {}\n")
    expect(byId(symbols, "#f").signature?.throws).toEqual([])
  })

  it("stops at an anonymous token, not only at the next named node", async () => {
    // `{ comment ; method }` — the stray semicolon sits between the two, and it is an
    // anonymous node. Stepping over it would hand `m` a comment that stops short of it,
    // so the run reads every sibling rather than only the named ones.
    const symbols = await symbolsOf("class C { /** @throws StrayError */ ; m() {} }\n")
    expect(byId(symbols, "#C.m").signature?.throws).toEqual([])
  })

  it("anchors on the export wrapper, so a comment above `export` still counts", async () => {
    const symbols = await symbolsOf(
      ["/** @throws WrappedError */", "export function f() {}", ""].join("\n"),
    )
    expect(byId(symbols, "#f").signature?.throws).toEqual(["WrappedError"])
  })
})

describe("decorator run", () => {
  it("gives each member only the decorators written above it", async () => {
    const symbols = await symbolsOf(
      ["class C {", "  @A()", "  first() {}", "  @B()", "  second() {}", "}", ""].join("\n"),
    )
    expect(byId(symbols, "#C.first").decorators.map((d) => d.name)).toEqual(["A"])
    expect(byId(symbols, "#C.second").decorators.map((d) => d.name)).toEqual(["B"])
  })

  it("reads none for the first member of a class body", async () => {
    const symbols = await symbolsOf("class C {\n  first() {}\n  @B()\n  second() {}\n}\n")
    expect(byId(symbols, "#C.first").decorators).toEqual([])
  })

  it("stops at the first non-decorator sibling", async () => {
    // `@A()` decorates `first`. Nothing decorates `second`, and a run that walked past
    // `first` would attach A to every member below it.
    const symbols = await symbolsOf(
      ["class C {", "  @A()", "  first() {}", "  second() {}", "}", ""].join("\n"),
    )
    expect(byId(symbols, "#C.second").decorators).toEqual([])
  })

  it("reads an exported declaration's decorators off the export wrapper", async () => {
    // The grammar hoists decorators onto the `export_statement`, so they are children of
    // the wrapper rather than siblings of the class — a different branch from the run.
    const symbols = await symbolsOf("@Injectable()\nexport class C {}\n")
    expect(byId(symbols, "#C").decorators.map((d) => d.name)).toEqual(["Injectable"])
  })
})
