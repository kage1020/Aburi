import { describe, expect, it } from "vitest"
import { byId, symbolsOf } from "./fixtures/ctx"

const lines = (...written: string[]) => [...written, ""].join("\n")

describe("the decorators a declaration carries", () => {
  it.each([
    [
      "the ones above each member",
      lines("class C {", "  @A()", "  first() {}", "  @B()", "  second() {}", "}"),
      "#C.second",
      ["B"],
    ],
    [
      "none for the first member of a class body",
      lines("class C {", "  first() {}", "  @B()", "  second() {}", "}"),
      "#C.first",
      [],
    ],
    [
      "none past the first non-decorator sibling",
      lines("class C {", "  @A()", "  first() {}", "  second() {}", "}"),
      "#C.second",
      [],
    ],
    ["one above `export`", lines("@Injectable()", "export class C {}"), "#C", ["Injectable"]],
    [
      "one above `export default`",
      lines("@Injectable()", "export default class C {}"),
      "#C",
      ["Injectable"],
    ],
    [
      "one past a comment above `export`",
      lines("@Injectable()", "// keep this one", "export class C {}"),
      "#C",
      ["Injectable"],
    ],
    [
      "a run a comment splits",
      lines("@A()", "// note", "@B()", "export class C {}"),
      "#C",
      ["A", "B"],
    ],
    [
      "a member's run a comment splits",
      lines("class C {", "  @A()", "  // note", "  m() {}", "}"),
      "#C.m",
      ["A"],
    ],
    [
      "one on a declaration that is not exported",
      lines("@Injectable()", "class C {}"),
      "#C",
      ["Injectable"],
    ],
    ["one written after `export`", lines("export @Injectable() class C {}"), "#C", ["Injectable"]],
    [
      "one written after `export default`",
      lines("export default @Injectable() class C {}"),
      "#C",
      ["Injectable"],
    ],
    [
      "one on an abstract class",
      lines("@Injectable()", "abstract class C {}"),
      "#C",
      ["Injectable"],
    ],
    [
      "several, in source order",
      lines("@A()", "@B()", "@Cee()", "class C {}"),
      "#C",
      ["A", "B", "Cee"],
    ],
    [
      "a run inside the declaration a comment splits",
      lines("@A()", "// note", "@B()", "class C {}"),
      "#C",
      ["A", "B"],
    ],
    [
      "runs on both sides of `export`, the outer first",
      lines("@First()", "export @Second() class C {}"),
      "#C",
      ["First", "Second"],
    ],
    ["a bare decorator with no call", lines("@Injectable", "class C {}"), "#C", ["Injectable"]],
    [
      "one named after its expression, not a comment inside it",
      lines("@/* why */ Foo()", "class C {}"),
      "#C",
      ["Foo"],
    ],
    [
      "two on one line in source order, not name order",
      lines("@Zed() @Alpha() class C {}"),
      "#C",
      ["Zed", "Alpha"],
    ],
    [
      "a member's two on one line",
      lines("class C { @UseGuards(G) @Get() m() {} }"),
      "#C.m",
      ["UseGuards", "Get"],
    ],
    [
      "two after `export` on one line",
      lines('export @UseGuards(G) @Controller("x") class C {}'),
      "#C",
      ["UseGuards", "Controller"],
    ],
    [
      "no parameter's decorator as the method's",
      lines("class C {", "  m(@P() x: number) {}", "}"),
      "#C.m",
      [],
    ],
    [
      "no member's parameter decorator as the class's",
      lines("class C {", "  m(@P() x: number) {}", "}"),
      "#C",
      [],
    ],
    [
      "no constructor parameter's decorator as the constructor's",
      lines("class C {", "  constructor(@Inject() private a: string) {}", "}"),
      "#C.constructor",
      [],
    ],
  ])("are %s", async (_label, source, id, names) => {
    expect(byId(await symbolsOf(source), id).decorators.map((d) => d.name)).toEqual(names)
  })

  it("keeps two of the same name on one line in source order", async () => {
    const symbols = await symbolsOf(lines('class C { @A("one") @A("two") m() {} }'))

    expect(byId(symbols, "#C.m").decorators.map((d) => d.raw)).toEqual(['A("one")', 'A("two")'])
  })
})
