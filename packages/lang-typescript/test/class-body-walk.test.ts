import type { WalkContext } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { Node } from "web-tree-sitter"
import { extractSymbols, walkBody } from "../src/index"
import {
  callsOf,
  classOf,
  makeExtractionCtx,
  parseSource,
  requireTree,
  walkOf,
} from "./fixtures/ctx"

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
 *
 * A member written as a field holding a function is a member too (`functionValuedField`), so
 * every behaviour below is pinned for both spellings where both exist.
 */

const MERGED_METHODS = [
  "export class C {",
  "  m() { first() }",
  "}",
  "export class C {",
  "  seed = field()",
  "  n() { second() }",
  "}",
].join("\n")

const MERGED_FIELDS = [
  "export class C {",
  "  first = () => { one() }",
  "}",
  "export class C {",
  "  second = () => { two() }",
  "}",
].join("\n")

const USER_SERVICE = [
  "export class UserService {",
  "  constructor(private readonly prisma: PrismaClient) {}",
  "  async create(data: unknown) {",
  "    return this.prisma.user.create({ data })",
  "  }",
  "}",
].join("\n")

/** Asserts the call targets each named Symbol's walk reports for `source`. */
async function expectCalls(source: string, expected: Record<string, string[]>): Promise<void> {
  for (const [id, targets] of Object.entries(expected)) {
    expect(await callsOf(source, id), id).toEqual(targets)
  }
}

describe("a member's body belongs to the member's own Symbol", () => {
  it.each([
    [
      "a method",
      USER_SERVICE,
      {
        "ts:src/a.ts#UserService": [],
        "ts:src/a.ts#UserService.create": ["this.prisma.user.create"],
      },
    ],
    [
      "a field holding a function",
      classOf(
        "  create = async (data: unknown) => {",
        "    return this.prisma.user.create({ data })",
        "  }",
      ),
      { "ts:src/a.ts#C": [], "ts:src/a.ts#C.create": ["this.prisma.user.create"] },
    ],
  ])("leaves the class with none of %s's calls", async (_label, source, expected) => {
    await expectCalls(source, expected)
  })

  it.each([
    ["a method", classOf("  m(x: unknown) {", "    if (x) throw new E()", "  }")],
    [
      "a field holding a function",
      classOf("  m = (x: unknown) => {", "    if (x) throw new E()", "  }"),
    ],
  ])("moves %s's rules off the class as well as its calls", async (_label, source) => {
    expect((await walkOf(source, "ts:src/a.ts#C")).rules).toEqual([])
    expect((await walkOf(source, "ts:src/a.ts#C.m")).rules.map((r) => r.type)).toEqual([
      "guard",
      "throw",
    ])
  })

  it("moves both halves of an accessor pair off the class", async () => {
    const source = classOf("  get v() { return read() }", "  set v(n) { write(n) }")

    await expectCalls(source, { "ts:src/a.ts#C": [], "ts:src/a.ts#C.v": ["read", "write"] })
  })

  it("moves a concrete method's body off an abstract class", async () => {
    // `abstract_class_declaration` is its own node type, and its concrete members are Symbols
    // like any other class's.
    const source = [
      "export abstract class C {",
      "  abstract m(): void",
      "  n() { inner() }",
      "}",
    ].join("\n")

    await expectCalls(source, { "ts:src/a.ts#C": [], "ts:src/a.ts#C.n": ["inner"] })
  })

  it.each([
    [
      "methods",
      MERGED_METHODS,
      { "ts:src/a.ts#C": ["field"], "ts:src/a.ts#C.m": ["first"], "ts:src/a.ts#C.n": ["second"] },
    ],
    [
      "fields holding functions",
      MERGED_FIELDS,
      { "ts:src/a.ts#C": [], "ts:src/a.ts#C.first": ["one"], "ts:src/a.ts#C.second": ["two"] },
    ],
  ])("applies the skip to every body a merged class was written with — %s", async (_l, source, expected) => {
    // `tsc` calls this TS2300; tree-sitter accepts it, and the second `class_body` arrives on
    // `mergedDeclarations`. A skip that only looked at `bodyNode` would leave half the
    // duplication in place — and one that walked neither would lose the second member
    // entirely, so both members are asserted as well as the class.
    await expectCalls(source, expected)
  })

  it("reads the class off the body, not off the Symbol that leads it", async () => {
    // `const C = 1` is written first, so it heads the folded Symbol and `fullNode` is a
    // `lexical_declaration` — which has no `name` field, so a predicate asked about *that* node
    // answers "this class has no member Symbols" and skips nothing. `inner` then landed on the
    // class as well as on `#C.m`, which is the state this whole change removes. The class node
    // is a `class_body`'s parent by construction, so that is where it is read from.
    const source = ["const C = 1", "class C { m() { inner() } }"].join("\n")

    await expectCalls(source, { "ts:src/a.ts#C": [], "ts:src/a.ts#C.m": ["inner"] })
  })
})

describe("a class Symbol keeps what defining and constructing it runs", () => {
  it.each([
    ["a method", classOf("  m(x = f()) { g() }")],
    ["a field holding a function", classOf("  m = (x = f()) => { g() }")],
  ])("keeps %s's parameter default, which no member Symbol walks", async (_label, source) => {
    // A member Symbol's `bodyNode` is the function's body, so its parameter list is not walked
    // there (LP20d). Skipping the whole member rather than its body would lose `f` entirely.
    await expectCalls(source, { "ts:src/a.ts#C": ["f"], "ts:src/a.ts#C.m": ["g"] })
  })

  it("does not treat a static member named constructor as the construction path", async () => {
    // `new C()` never runs a static method, so a `static constructor` is not on the path LP20b
    // is about. `tsc` refuses it, but this plugin also claims `.js`, where it is legal — and
    // reading it as the constructor both put its body on the class and gave it the instance
    // qname, where it collided with the real constructor's.
    const source = classOf("  constructor() { real() }", "  static constructor() { boom() }")

    await expectCalls(source, {
      "ts:src/a.ts#C": ["real"],
      "ts:src/a.ts#C.constructor": ["real"],
      "ts:src/a.ts#C::constructor": ["boom"],
    })
  })

  it.each([
    ["a method", classOf("  @Inject(makeToken())", "  m() { inner() }")],
    ["a field holding a function", classOf("  @Inject(makeToken())", "  m = () => { inner() }")],
  ])("keeps a call written in %s's decorator arguments", async (_label, source) => {
    // A method's decorator is a **sibling** of its `method_definition` inside `class_body`, and
    // a field's is a child of the field outside the arrow — so neither is inside the body the
    // skip removes. `@Inject(...)` is itself a call, hence two.
    await expectCalls(source, {
      "ts:src/a.ts#C": ["Inject", "makeToken"],
      "ts:src/a.ts#C.m": ["inner"],
    })
  })
})

describe("a member with no Symbol keeps its body on the class", () => {
  it("keeps an anonymous default class's member bodies", async () => {
    // `<default>` is reserved for the class itself and `<default>.m` is not a qualified name
    // the id builder accepts, so an anonymous default class's members are not Symbols either.
    const source = ["export default class {", "  m() { hidden() }", "}"].join("\n")

    expect(await callsOf(source, "ts:src/a.ts#<default>")).toEqual(["hidden"])
  })

  it("says nothing extra for an overload signature, which has no body", async () => {
    const source = classOf("  m(a: string): void", "  m(a: unknown) { inner() }")

    await expectCalls(source, { "ts:src/a.ts#C": [], "ts:src/a.ts#C.m": ["inner"] })
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

    await expectCalls(source, { "ts:src/a.ts#Outer.build": ["x"], "ts:src/a.ts#Outer": [] })
  })
})

describe("the two readers of “does this member have a Symbol?” agree", () => {
  // The property the whole change rests on: a member body is walked by exactly one Symbol.
  // Every call below is written once in the source, so a target on two Symbols is a body
  // counted twice, and one on none is a body lost. The constructor is the documented exception
  // — `new C()` runs it and resolves to the class (LP20b) — so it is on exactly two.
  const EVERY_MEMBER_SHAPE = [
    "export class Shapes {",
    "  seed = fieldInit()",
    "  static { staticBlock() }",
    "  constructor() { ctorBody() }",
    "  plain() { plainBody() }",
    "  static stat() { staticBody() }",
    "  get v() { getterBody() }",
    "  set v(n) { setterBody() }",
    "  #hidden() { privateBody() }",
    "  [computed()]() { computedBody() }",
    "  withDefault(x = defaultValue()) { defaultedBody() }",
    "  @Dec(decoratorArg())",
    "  decorated() { decoratedBody() }",
    "  over(a: string): void",
    "  over(a: unknown) { overBody() }",
    "  nests() { class Inner { m() { nestedBody() } } return Inner }",
    "  arrowField = () => { arrowFieldBody() }",
    "  exprArrowField = () => exprArrowFieldBody()",
    "  static staticArrowField = () => { staticArrowFieldBody() }",
    "  #hiddenArrowField = () => { hiddenArrowFieldBody() }",
    "  fnField = function () { fnFieldBody() }",
    "  genField = function* () { genFieldBody() }",
    "  [computedField()] = () => { computedFieldBody() }",
    "  plainField = plainFieldInit()",
    "  readonly roField = () => { roFieldBody() }",
    "  optField?: H = () => { optFieldBody() }",
    "  accessor accField = () => { accFieldBody() }",
    "  static #staticHashField = () => { staticHashFieldBody() }",
    '  "quoted"() { quotedBody() }',
    '  "not-a-name"() { hyphenBody() }',
    "  1() { numericBody() }",
    '  "quotedField" = () => { quotedFieldBody() }',
    '  "not-a-field" = () => { hyphenFieldBody() }',
    "}",
  ].join("\n")

  it("walks every member body exactly once, and the constructor's on the class as well", async () => {
    const result = await parseSource(EVERY_MEMBER_SHAPE)
    const ctx = makeExtractionCtx("src/a.ts", EVERY_MEMBER_SHAPE)
    const symbols = extractSymbols(requireTree(result.tree), ctx)

    const owners = new Map<string, string[]>()
    for (const symbol of symbols) {
      const walkCtx: WalkContext<Node> = { ...ctx, symbol }
      for (const call of walkBody(symbol, walkCtx).calls) {
        owners.set(call.target, [...(owners.get(call.target) ?? []), symbol.id])
      }
    }

    const written = [
      "fieldInit",
      "staticBlock",
      "ctorBody",
      "plainBody",
      "staticBody",
      "getterBody",
      "setterBody",
      "privateBody",
      "computed",
      "computedBody",
      "defaultValue",
      "defaultedBody",
      "Dec",
      "decoratorArg",
      "decoratedBody",
      "overBody",
      "nestedBody",
      "arrowFieldBody",
      "exprArrowFieldBody",
      "staticArrowFieldBody",
      "hiddenArrowFieldBody",
      "fnFieldBody",
      "genFieldBody",
      "computedField",
      "computedFieldBody",
      "plainFieldInit",
      "roFieldBody",
      "optFieldBody",
      "accFieldBody",
      "staticHashFieldBody",
      "quotedBody",
      "hyphenBody",
      "numericBody",
      "quotedFieldBody",
      "hyphenFieldBody",
    ]
    const counts = Object.fromEntries(written.map((t) => [t, owners.get(t)?.length ?? 0]))

    expect(counts).toEqual({
      ...Object.fromEntries(written.map((t) => [t, 1])),
      ctorBody: 2,
    })
    expect(owners.get("ctorBody")?.slice().sort()).toEqual([
      "ts:src/a.ts#Shapes",
      "ts:src/a.ts#Shapes.constructor",
    ])
  })
})
