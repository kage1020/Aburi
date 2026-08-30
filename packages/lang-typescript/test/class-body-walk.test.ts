import type { BodyExtraction, WalkContext } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { Node } from "web-tree-sitter"
import { extractSymbols, parseTypescriptFile, walkBody } from "../src/index"
import { makeExtractionCtx, requireTree } from "./fixtures/ctx"

/**
 * A class Symbol's `bodyNode` is the whole `class_body`, and the walk descended into every
 * member — so each method's calls and rules were recorded a second time on the class. `new C()`
 * resolves to the class Symbol (`call-resolution.md` CR15), so the duplicates then propagated
 * to callers that touch nothing.
 *
 * What a class Symbol's body is, is what **defining and constructing** the class runs: field
 * initialisers, static blocks, and the constructor. A method body belongs to the method's own
 * Symbol, and is skipped here — but only when there *is* one, because a member with no Symbol
 * has nowhere else to be recorded.
 */

async function walkOf(source: string, id: string): Promise<BodyExtraction> {
  const result = await parseTypescriptFile({ path: "src/a.ts", content: source })
  const ctx = makeExtractionCtx("src/a.ts", source)
  const target = extractSymbols(requireTree(result.tree), ctx).find((s) => s.id === id)
  if (target === undefined) throw new Error(`no Symbol ${id} in fixture`)
  const walkCtx: WalkContext<Node> = { ...ctx, symbol: target }
  return walkBody(target, walkCtx)
}

async function callsOf(source: string, id: string): Promise<string[]> {
  return (await walkOf(source, id)).calls.map((c) => c.target)
}

const USER_SERVICE = [
  "export class UserService {",
  "  constructor(private readonly prisma: PrismaClient) {}",
  "  async create(data: unknown) {",
  "    return this.prisma.user.create({ data })",
  "  }",
  "}",
].join("\n")

describe("a member's body belongs to the member's own Symbol", () => {
  it("leaves the class with none of its methods' calls", async () => {
    expect(await callsOf(USER_SERVICE, "ts:src/a.ts#UserService")).toEqual([])
    expect(await callsOf(USER_SERVICE, "ts:src/a.ts#UserService.create")).toEqual([
      "this.prisma.user.create",
    ])
  })

  it("moves a method's rules off the class as well as its calls", async () => {
    const source = [
      "export class C {",
      "  m(x: unknown) {",
      "    if (x) throw new E()",
      "  }",
      "}",
    ].join("\n")

    expect((await walkOf(source, "ts:src/a.ts#C")).rules).toEqual([])
    expect((await walkOf(source, "ts:src/a.ts#C.m")).rules.map((r) => r.type)).toEqual([
      "guard",
      "throw",
    ])
  })

  it("moves both halves of an accessor pair off the class", async () => {
    const source = [
      "export class C {",
      "  get v() { return read() }",
      "  set v(n) { write(n) }",
      "}",
    ].join("\n")

    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual([])
    expect(await callsOf(source, "ts:src/a.ts#C.v")).toEqual(["read", "write"])
  })

  it("moves a static method's body off the class", async () => {
    const source = ["export class C {", "  static m() { inner() }", "}"].join("\n")

    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual([])
    expect(await callsOf(source, "ts:src/a.ts#C::m")).toEqual(["inner"])
  })

  it("applies the skip to every body a merged class was written with", async () => {
    // `tsc` calls this TS2300; tree-sitter accepts it, and the second `class_body` arrives on
    // `mergedDeclarations`. A skip that only looked at `bodyNode` would leave half the
    // duplication in place.
    const source = [
      "export class C {",
      "  m() { first() }",
      "}",
      "export class C {",
      "  n() { second() }",
      "}",
    ].join("\n")

    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual([])
  })
})

describe("a class Symbol keeps what defining and constructing it runs", () => {
  it("keeps a field initialiser and a static block", async () => {
    const source = [
      "export class C {",
      "  a = makeA()",
      "  static { boot() }",
      "  m() { inner() }",
      "}",
    ].join("\n")

    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(["makeA", "boot"])
  })

  it("keeps the constructor's body, which is also the constructor Symbol's", async () => {
    // The one member whose body stays. `new C()` resolves to the **class** Symbol
    // (`call-resolution.md` CR15) and runs the constructor, so a constructor that writes to a
    // database has to be visible to every caller that instantiates the class. Nothing resolves
    // a call to `#C.constructor`, so recording it twice propagates it nowhere twice.
    const source = ["export class C {", "  constructor() { audit() }", "}"].join("\n")

    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(["audit"])
    expect(await callsOf(source, "ts:src/a.ts#C.constructor")).toEqual(["audit"])
  })

  it("keeps a parameter default, which no member Symbol walks", async () => {
    // A method Symbol's `bodyNode` is its `statement_block`, so its parameter list is not
    // walked there. Skipping the whole member rather than its body would lose `f` entirely.
    const source = ["export class C {", "  m(x = f()) { g() }", "}"].join("\n")

    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(["f"])
    expect(await callsOf(source, "ts:src/a.ts#C.m")).toEqual(["g"])
  })

  it("keeps a call written in a member decorator's arguments", async () => {
    const source = ["export class C {", "  @Inject(makeToken())", "  m() { inner() }", "}"].join(
      "\n",
    )

    // `@Inject(...)` is itself a call in the grammar, so the decorator contributes two.
    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(["Inject", "makeToken"])
  })
})

describe("a member with no Symbol keeps its body on the class", () => {
  it("keeps a computed member's body", async () => {
    // A computed name is not a name static analysis can record, so the member has no Symbol.
    // Skipping its body would lose the calls in it with no Symbol, no diagnostic and nothing
    // to say so.
    const source = [
      "export class C {",
      "  [Symbol.iterator]() { hidden() }",
      "  m() { inner() }",
      "}",
    ].join("\n")

    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual(["hidden"])
  })

  it("keeps an anonymous default class's member bodies", async () => {
    // `<default>` is reserved for the class itself and `<default>.m` is not a qualified name
    // the id builder accepts, so an anonymous default class's members are not Symbols either.
    const source = ["export default class {", "  m() { hidden() }", "}"].join("\n")

    expect(await callsOf(source, "ts:src/a.ts#<default>")).toEqual(["hidden"])
  })

  it("says nothing extra for an overload signature, which has no body", async () => {
    const source = [
      "export class C {",
      "  m(a: string): void",
      "  m(a: unknown) { inner() }",
      "}",
    ].join("\n")

    expect(await callsOf(source, "ts:src/a.ts#C")).toEqual([])
    expect(await callsOf(source, "ts:src/a.ts#C.m")).toEqual(["inner"])
  })
})

describe("the skip reaches the Symbol's own body and no other", () => {
  it("keeps a class written inside a function's body whole", async () => {
    // `Inner` is not extracted — nested classes are not module-level declarations — so every
    // call in it belongs to `f`. A skip applied to any `class_body` the walk meets would drop
    // `x` from the only Symbol that could carry it.
    const source = [
      "export function f() {",
      "  class Inner {",
      "    m() { x() }",
      "  }",
      "  return Inner",
      "}",
    ].join("\n")

    expect(await callsOf(source, "ts:src/a.ts#f")).toEqual(["x"])
  })

  it("keeps a class written inside a method's body whole", async () => {
    const source = [
      "export class Outer {",
      "  build() {",
      "    class Inner {",
      "      m() { x() }",
      "    }",
      "    return Inner",
      "  }",
      "}",
    ].join("\n")

    expect(await callsOf(source, "ts:src/a.ts#Outer.build")).toEqual(["x"])
    expect(await callsOf(source, "ts:src/a.ts#Outer")).toEqual([])
  })
})
