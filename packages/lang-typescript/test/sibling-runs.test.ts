import type { SymbolCandidate } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { Node } from "web-tree-sitter"
import { extractSymbols, parseTypescriptFile } from "../src/index"
import { makeExtractionCtx, requireTree } from "./fixtures/ctx"

/**
 * What belongs to a declaration and what merely sits near it, for the two things read from
 * the nodes around one: its JSDoc and its decorators.
 *
 * Neither is a plain run of preceding siblings. The decorators are the preceding-sibling run
 * *and* the declaration's own `decorator:` field children, since the grammar parents them on
 * one side or the other depending on where they were written relative to `export`. The JSDoc
 * run steps over decorators and over comments that are not documentation. So the boundaries
 * are a set of decisions rather than one rule, and these pin them.
 *
 * They are observable in two places:
 *   - the JSDoc run through `signature.throws`, which unions the `@throws` tags of the
 *     collected blocks (signature.ts `readThrows`);
 *   - the decorators through `decorators[]`, in source order.
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

  it("steps over a decorator, because a JSDoc above one still documents the member", async () => {
    // `/** doc */ @Get() handler() {}` is idiomatic, and the decorator belongs to the member
    // rather than separating anything from it — the mirror of the comment a decorator run
    // has to skip.
    const symbols = await symbolsOf("class C {\n  /** @throws E */\n  @A()\n  m() {}\n}\n")
    expect(byId(symbols, "#C.m").signature?.throws).toEqual(["E"])
  })

  it("reads a comment written between the decorator and the member", async () => {
    const symbols = await symbolsOf("class C {\n  @A()\n  /** @throws E */\n  m() {}\n}\n")
    expect(byId(symbols, "#C.m").signature?.throws).toEqual(["E"])
  })

  it("steps over the decorator without absorbing its text", async () => {
    // Skipping and collecting are one line apart. A decorator argument that happens to
    // mention `@throws` is the difference: it is source, not documentation.
    const symbols = await symbolsOf('class C {\n  @Doc("@throws NotAThrow")\n  m() {}\n}\n')
    expect(byId(symbols, "#C.m").signature?.throws).toEqual([])
  })

  it("does not let stepping over a decorator reach the previous member's comment", async () => {
    const symbols = await symbolsOf(
      [
        "class C {",
        "  /** @throws OwnedByFirst */",
        "  first() {}",
        "  @A()",
        "  m() {}",
        "}",
        "",
      ].join("\n"),
    )
    expect(byId(symbols, "#C.m").signature?.throws).toEqual([])
    expect(byId(symbols, "#C.first").signature?.throws).toEqual(["OwnedByFirst"])
  })

  it("does not read a note left after the previous member as the next one's", async () => {
    // The comment sits *after* `first` and before `m`'s decorator, which is where a reader
    // writes about the member above. Stepping over the decorator makes it reachable; only
    // its not being a JSDoc block keeps it out.
    const symbols = await symbolsOf(
      [
        "class C {",
        "  first() { return 1 }",
        "  // NOTE: first() can @throws Trailing in legacy mode",
        "  @Get()",
        "  m() { return 2 }",
        "}",
        "",
      ].join("\n"),
    )
    expect(byId(symbols, "#C.m").signature?.throws).toEqual([])
    expect(byId(symbols, "#C.first").signature?.throws).toEqual([])
  })

  it("does not read a lint suppression written among the decorators", async () => {
    const symbols = await symbolsOf(
      [
        "class C {",
        "  @A()",
        "  // biome-ignore lint/x: @throws Sneaky",
        "  @B()",
        "  m() {}",
        "}",
        "",
      ].join("\n"),
    )
    expect(byId(symbols, "#C.m").signature?.throws).toEqual([])
  })

  it("reads only `/**` blocks, not every comment", async () => {
    // The one consumer scans the joined text for `@throws`, and cannot tell prose from a
    // declaration once both are in it. `//` and `/* */` are prose.
    const line = await symbolsOf("class C {\n  // @throws Legacy\n  m() {}\n}\n")
    expect(byId(line, "#C.m").signature?.throws).toEqual([])
    const block = await symbolsOf("class C {\n  /* @throws Blocky */\n  m() {}\n}\n")
    expect(byId(block, "#C.m").signature?.throws).toEqual([])
  })

  it("steps over a note between two JSDoc blocks rather than stopping at it", async () => {
    const symbols = await symbolsOf(
      [
        "class C {",
        "  /** @throws Outer */",
        "  // an aside",
        "  /** @throws Inner */",
        "  m() {}",
        "}",
        "",
      ].join("\n"),
    )
    expect(byId(symbols, "#C.m").signature?.throws).toEqual(["Inner", "Outer"])
  })

  it("collects two blocks a decorator sits between", async () => {
    const symbols = await symbolsOf(
      [
        "class C {",
        "  /** @throws One */",
        "  @A()",
        "  /** @throws Two */",
        "  m() {}",
        "}",
        "",
      ].join("\n"),
    )
    expect(byId(symbols, "#C.m").signature?.throws).toEqual(["One", "Two"])
  })

  it("still stops at an anonymous token when a decorator follows it", async () => {
    const symbols = await symbolsOf("class C { /** @throws Stray */ ; @A() m() {} }\n")
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

describe("decorators parented inside the declaration", () => {
  /**
   * When nothing else owns the declaration, the grammar makes the decorator a `decorator:`
   * field child of the declaration itself rather than a preceding sibling. Same decorator,
   * same meaning, different parent — so both placements have to be read.
   */
  it("reads one on a declaration that is not exported", async () => {
    const symbols = await symbolsOf("@Injectable()\nclass C {}\n")
    expect(byId(symbols, "#C").decorators.map((d) => d.name)).toEqual(["Injectable"])
  })

  it("reads one written after the `export` keyword", async () => {
    const symbols = await symbolsOf("export @Injectable() class C {}\n")
    expect(byId(symbols, "#C").decorators.map((d) => d.name)).toEqual(["Injectable"])
  })

  it("reads one written after `export default`", async () => {
    const symbols = await symbolsOf("export default @Injectable() class C {}\n")
    expect(byId(symbols, "#C").decorators.map((d) => d.name)).toEqual(["Injectable"])
  })

  it("reads one on an abstract class, which is a different node type", async () => {
    const symbols = await symbolsOf("@Injectable()\nabstract class C {}\n")
    expect(byId(symbols, "#C").decorators.map((d) => d.name)).toEqual(["Injectable"])
  })

  it("keeps several in source order", async () => {
    const symbols = await symbolsOf("@A()\n@B()\n@Cee()\nclass C {}\n")
    expect(byId(symbols, "#C").decorators.map((d) => d.name)).toEqual(["A", "B", "Cee"])
  })

  it("is not ended by a comment, matching the sibling side", async () => {
    const symbols = await symbolsOf("@A()\n// note\n@B()\nclass C {}\n")
    expect(byId(symbols, "#C").decorators.map((d) => d.name)).toEqual(["A", "B"])
  })

  it("merges with the sibling run when a declaration is decorated on both sides", async () => {
    // `@A()` sits in the export wrapper, `@B()` inside the class. TypeScript rejects this as
    // TS8038 — decorators may not appear on both sides of `export` — but the grammar accepts
    // it, so it reaches the extractor from a half-edited file. Reading the union rather than
    // one side means such a file loses no decorator on the way to being reported.
    const symbols = await symbolsOf("@A()\nexport @B() class C {}\n")
    expect(byId(symbols, "#C").decorators.map((d) => d.name)).toEqual(["A", "B"])
  })

  it("reads a bare decorator with no call as well", async () => {
    const symbols = await symbolsOf("@Injectable\nclass C {}\n")
    expect(byId(symbols, "#C").decorators.map((d) => d.name)).toEqual(["Injectable"])
  })

  it("names a decorator after its expression, not after a comment inside it", async () => {
    // `@/* why */ Foo()` parses, and `leafIdentifier` falls back to a node's own text, so
    // taking the first named child unconditionally names the decorator "/* why */".
    const symbols = await symbolsOf("@/* why */ Foo()\nclass C {}\n")
    expect(byId(symbols, "#C").decorators.map((d) => d.name)).toEqual(["Foo"])
  })

  it("does not read a parameter's decorator as the method's", async () => {
    // A parameter decorator is a child of the parameter, not of the method, and the method
    // does not field-tag it. This is the negative that reading the field children could
    // plausibly break.
    const symbols = await symbolsOf("class C {\n  m(@P() x: number) {}\n}\n")
    expect(byId(symbols, "#C.m").decorators).toEqual([])
  })

  it("does not read a constructor parameter's decorator as the constructor's", async () => {
    const symbols = await symbolsOf("class C {\n  constructor(@Inject() private a: string) {}\n}\n")
    expect(byId(symbols, "#C.constructor").decorators).toEqual([])
  })

  it("does not read a member's parameter decorator as the class's", async () => {
    const symbols = await symbolsOf("class C {\n  m(@P() x: number) {}\n}\n")
    expect(byId(symbols, "#C").decorators).toEqual([])
  })
})

/**
 * `framework-nestjs` resolves a class carrying several recognised decorators by taking the
 * first in source order, so the order is a contract rather than a presentation choice. Two
 * decorators can share a line and `Decorator` has no column, so anything that falls back on
 * the line number has to break the tie some other way — and any tie-break that reads the
 * decorator's *name* makes the classification depend on the alphabet.
 */
describe("decorator order", () => {
  it("keeps two on one line in source order, not in name order", async () => {
    const symbols = await symbolsOf("@Zed() @Alpha() class C {}\n")
    expect(byId(symbols, "#C").decorators.map((d) => d.name)).toEqual(["Zed", "Alpha"])
  })

  it("gives the same order whether or not they share a line", async () => {
    const oneLine = await symbolsOf("@Injectable() @Catch(E) class F {}\n")
    const twoLines = await symbolsOf("@Injectable()\n@Catch(E)\nclass F {}\n")
    expect(byId(oneLine, "#F").decorators.map((d) => d.name)).toEqual(["Injectable", "Catch"])
    expect(byId(twoLines, "#F").decorators.map((d) => d.name)).toEqual(["Injectable", "Catch"])
  })

  it("keeps a class member's in source order on one line", async () => {
    const symbols = await symbolsOf("class C { @UseGuards(G) @Get() m() {} }\n")
    expect(byId(symbols, "#C.m").decorators.map((d) => d.name)).toEqual(["UseGuards", "Get"])
  })

  it("keeps one written after `export` in source order on one line", async () => {
    const symbols = await symbolsOf('export @UseGuards(G) @Controller("x") class C {}\n')
    expect(byId(symbols, "#C").decorators.map((d) => d.name)).toEqual(["UseGuards", "Controller"])
  })

  it("keeps two of the same name on one line in source order", async () => {
    // Same line and same name: nothing but the source position separates these, and
    // `@ApiResponse(...) @ApiResponse(...)` is an ordinary way to write them.
    const symbols = await symbolsOf('class C { @A("one") @A("two") m() {} }\n')
    expect(byId(symbols, "#C.m").decorators.map((d) => d.raw)).toEqual(['A("one")', 'A("two")'])
  })

  it("orders the sibling run ahead of the field children", async () => {
    const symbols = await symbolsOf("@First()\nexport @Second() class C {}\n")
    expect(byId(symbols, "#C").decorators.map((d) => d.name)).toEqual(["First", "Second"])
  })
})
