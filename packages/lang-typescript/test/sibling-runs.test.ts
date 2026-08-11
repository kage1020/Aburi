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

  it("stops at a decorator, so a JSDoc written above one is not read", async () => {
    // `/** doc */ @Get() handler() {}` is idiomatic and its JSDoc plainly documents the
    // method, so this is a gap rather than a rule — the mirror of the comment a decorator
    // run has to skip. Pinned rather than closed here: `signature.throws` feeds the api and
    // logic fingerprints, so widening it reclassifies Symbols across a whole corpus on
    // upgrade, which is a decision of its own and not one a performance change should make.
    const symbols = await symbolsOf("class C {\n  /** @throws E */\n  @A()\n  m() {}\n}\n")
    expect(byId(symbols, "#C.m").signature?.throws).toEqual([])
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

  it("reaches an exported declaration's decorators inside the export wrapper", async () => {
    // The grammar's rule is `decorator* 'export' declaration`, so the decorators sit in the
    // wrapper with two anonymous tokens between them and the class. The named walk steps
    // over those, which is the only reason one walk covers both placements.
    const symbols = await symbolsOf("@Injectable()\nexport class C {}\n")
    expect(byId(symbols, "#C").decorators.map((d) => d.name)).toEqual(["Injectable"])
  })

  it("reaches them past `export default` too", async () => {
    const symbols = await symbolsOf("@Injectable()\nexport default class C {}\n")
    expect(byId(symbols, "#C").decorators.map((d) => d.name)).toEqual(["Injectable"])
  })

  it("does not let a comment detach a decorator from what it decorates", async () => {
    // A comment is a named node and lands wherever it was written, so it can sit between
    // the decorator and the `export` keyword. Ending the run there loses the decorator
    // silently — decorators feed the framework classifier, so the Symbol comes out with
    // the wrong extKind rather than with an error.
    const symbols = await symbolsOf("@Injectable()\n// keep this one\nexport class C {}\n")
    expect(byId(symbols, "#C").decorators.map((d) => d.name)).toEqual(["Injectable"])
  })

  it("does not let a comment split a decorator run in half", async () => {
    const symbols = await symbolsOf("@A()\n// note\n@B()\nexport class C {}\n")
    expect(byId(symbols, "#C").decorators.map((d) => d.name)).toEqual(["A", "B"])
  })

  it("skips a comment inside a class member's run as well", async () => {
    const symbols = await symbolsOf("class C {\n  @A()\n  // note\n  m() {}\n}\n")
    expect(byId(symbols, "#C.m").decorators.map((d) => d.name)).toEqual(["A"])
  })
})

describe("decorators the walk does not reach", () => {
  /**
   * A decorator with no wrapper to hold it is parsed as the first *child* of the
   * declaration, not as a sibling — so neither the walk nor the child-list scan it replaced
   * finds it. These pin the answer as it stands rather than endorse it: closing the gap
   * would newly attach decorators to Symbols that have none today, moving `extKind` and
   * every fingerprint that reads it, which wants its own change.
   */
  it("misses a decorator on a declaration that is not exported", async () => {
    const symbols = await symbolsOf("@Injectable()\nclass C {}\n")
    expect(byId(symbols, "#C").decorators).toEqual([])
  })

  it("misses a decorator written after the `export` keyword", async () => {
    const symbols = await symbolsOf("export @Injectable() class C {}\n")
    expect(byId(symbols, "#C").decorators).toEqual([])
  })
})
