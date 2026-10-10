import { describe, expect, it } from "vitest"
import { byId, symbolsOf } from "./fixtures/ctx"

const lines = (...written: string[]) => [...written, ""].join("\n")

describe("the JSDoc run a declaration reads its @throws from", () => {
  it.each([
    [
      "every block in the run, not only the one touching the declaration",
      lines("/** @throws OuterError */", "/** @throws InnerError */", "function f() {}"),
      "#f",
      ["InnerError", "OuterError"],
    ],
    [
      "nothing past the first statement before it",
      lines("/** @throws StrayError */", "function before() {}", "function f() {}"),
      "#f",
      [],
    ],
    ["nothing for the first statement in a file", lines("function f() {}"), "#f", []],
    [
      "nothing past an anonymous token",
      lines("class C { /** @throws StrayError */ ; m() {} }"),
      "#C.m",
      [],
    ],
    [
      "nothing past an anonymous token a decorator follows",
      lines("class C { /** @throws Stray */ ; @A() m() {} }"),
      "#C.m",
      [],
    ],
    [
      "a block above `export`",
      lines("/** @throws WrappedError */", "export function f() {}"),
      "#f",
      ["WrappedError"],
    ],
    [
      "a block above a decorator",
      lines("class C {", "  /** @throws E */", "  @A()", "  m() {}", "}"),
      "#C.m",
      ["E"],
    ],
    [
      "a block between the decorator and the member",
      lines("class C {", "  @A()", "  /** @throws E */", "  m() {}", "}"),
      "#C.m",
      ["E"],
    ],
    [
      "two blocks a decorator sits between",
      lines("class C {", "  /** @throws One */", "  @A()", "  /** @throws Two */", "  m() {}", "}"),
      "#C.m",
      ["One", "Two"],
    ],
    [
      "nothing from a decorator's own text",
      lines("class C {", '  @Doc("@throws NotAThrow")', "  m() {}", "}"),
      "#C.m",
      [],
    ],
    [
      "nothing from the previous member's block, past a decorator",
      lines(
        "class C {",
        "  /** @throws OwnedByFirst */",
        "  first() {}",
        "  @A()",
        "  m() {}",
        "}",
      ),
      "#C.m",
      [],
    ],
    [
      "nothing from a note left after the previous member",
      lines(
        "class C {",
        "  first() { return 1 }",
        "  // NOTE: first() can @throws Trailing in legacy mode",
        "  @Get()",
        "  m() { return 2 }",
        "}",
      ),
      "#C.m",
      [],
    ],
    [
      "nothing from a line comment among the decorators",
      lines("class C {", "  @A()", "  // @throws Sneaky", "  @B()", "  m() {}", "}"),
      "#C.m",
      [],
    ],
    [
      "nothing from a line comment",
      lines("class C {", "  // @throws Legacy", "  m() {}", "}"),
      "#C.m",
      [],
    ],
    [
      "nothing from a plain block comment",
      lines("class C {", "  /* @throws Blocky */", "  m() {}", "}"),
      "#C.m",
      [],
    ],
    [
      "the blocks either side of a note",
      lines(
        "class C {",
        "  /** @throws Outer */",
        "  // an aside",
        "  /** @throws Inner */",
        "  m() {}",
        "}",
      ),
      "#C.m",
      ["Inner", "Outer"],
    ],
  ])("reads %s", async (_label, source, id, throws) => {
    expect(byId(await symbolsOf(source), id).signature?.throws).toEqual(throws)
  })

  it("leaves the block before an earlier declaration to that declaration", async () => {
    const symbols = await symbolsOf(
      lines("/** @throws StrayError */", "function before() {}", "function f() {}"),
    )

    expect(byId(symbols, "#before").signature?.throws).toEqual(["StrayError"])
  })
})
