import type { SymbolCandidate } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { Node } from "web-tree-sitter"
import { normalizeAst } from "../src/index"
import { callsOf, parseSource, symbolOf, symbolsOf } from "./fixtures/ctx"

/**
 * The typescript grammar has no rule for TypeScript 4.7's `in` / `out` variance modifiers, so
 * `interface A<out T>` was a parse error in a file `tsc` accepts. Recovery usually reads the first
 * modifier as the parameter's name and leaves the rest in an ERROR, but in some longer lists it
 * makes the modifier itself the ERROR instead. No published `@vscode/tree-sitter-wasm` has fixed it
 * as of 2026-09; the canary below is what will say when one does.
 *
 * `collectParseErrors` drops exactly that shape (`lang-plugin.md` LP27c). As with the JSX `&`,
 * these suites hold both halves of why that is safe: a file `tsc`'s parser rejects still reports,
 * and the Symbols come out the same with the modifiers as without them. Where either half stops
 * is written down at the end, as the JSX suite does.
 */

async function errorsOf(content: string, path = "src/a.ts"): Promise<string[]> {
  const result = await parseSource(content, path)
  return result.errors.map((e) => `${e.line}:${e.column} ${e.message}`)
}

describe("a variance modifier is not reported as a parse error", () => {
  it.each([
    ["`out` on an interface", "export interface A<out T> { v: T }"],
    ["`in` on an interface", "export interface B<in T> { f(t: T): void }"],
    ["`in out`", "export interface C<in out T> { v: T }"],
    ["`out` with a default", "export interface D<out T = unknown> { v: T }"],
    ["`in` with a default", "export interface E<in T = never> { f(t: T): void }"],
    ["`out` with a constraint", "export interface F<out T extends object> { v: T }"],
    ["`out` with a constraint and a default", "export interface G<out T extends X = Y> { v: T }"],
    ["`in out` with a default", "export interface H<in out T = X> { v: T }"],
    ["`in out` with a constraint", "export interface I<in out T extends object> { v: T }"],
    ["two parameters with defaults", "export interface Ib<out T = X, in U = Y> { f(u: U): T }"],
    ["a modifier on a later parameter", "export interface J<A, out B> { a: A; b: B }"],
    ["a modifier on every parameter", "export interface K<out T, in U> { f(u: U): T }"],
    ["`in out` beside a `const` parameter", "export class L<in out T, const U> { v!: [T, U] }"],
    ["a trailing comma", "export interface M<out T,> { v: T }"],
    ["a parameter per line", "export interface N<\n  out T,\n  in U,\n> { f(u: U): T }"],
    ["a class", "export class O<out T> { m() {} }"],
    ["an abstract class", "export abstract class P<in out T> { abstract m(t: T): T }"],
    ["a class expression", "export const Q = class<out T> {}"],
    ["an ambient class", "declare class R<out T> {}"],
    ["a type alias", "export type S<out T> = { v: T }"],
    ["`const` before the modifier", "export class U<const out T> { v!: T }"],
    ["`const` before `in out` with a default", "export class V<const in out T = X> { v!: T }"],
    ["an interface in a module declaration", 'declare module "m" { interface W<out T> {} }'],
    ["`const` after the modifier", "export class X<out const T> { v!: T }"],
    ["`const` between `in` and `out`", "export class Y<in const out T> { v!: T }"],
    ["an interface that extends another", "export interface Z<out T> extends B<T> { v: T }"],
    [
      "a class that extends and implements",
      "export class Ze<out T> extends D<T> implements E<T> { v!: T }",
    ],
  ])("%s", async (_label, source) => {
    expect(await errorsOf(source)).toEqual([])
  })

  it.each([
    ["a parameter named `out`", "export interface A<out> { v: out }"],
    ["a variable named `out`", "export const out = 1"],
    ["`out` as the name after an `out` modifier", "export interface B<out out> { v: out }"],
  ])("never reported %s either", async (_label, source) => {
    // Without these, the suite above would also pass had the word `out` simply stopped
    // reporting wherever it appears.
    expect(await errorsOf(source)).toEqual([])
  })
})

describe("a list where recovery makes the modifier the ERROR", () => {
  // Measured on `zod`, whose `ZodType` is written this way: every `out` is an ERROR of its own,
  // standing before a parameter that parsed clean. The same list with one parameter does not do
  // it, which is why the rule reads the words back rather than matching one shape.
  const listOf = (first: string, owner = "export interface A<", close = "> {}") =>
    `${owner}${first}, out Input = unknown, out Internals extends Base<Output, Input> = Base<Output, Input>${close}`

  it("is the shape this fixture gets, so the cases below exercise it", async () => {
    // Pinned in full so the cases below keep reaching this shape; a change in how recovery splits
    // the list fails here even while the grammar still lacks the rule.
    const { tree } = await parseSource(listOf("out Output = unknown"))
    const list = tree?.rootNode.descendantsOfType("type_parameters")[0]
    const shape = list?.children.filter((c) => c?.isNamed).map((c) => c?.type)
    expect(shape).toEqual([
      "ERROR",
      "type_parameter",
      "ERROR",
      "type_parameter",
      "ERROR",
      "type_parameter",
    ])
  })

  it.each([
    ["`out`", "out Output = unknown"],
    ["`in out`", "in out Output = unknown"],
    [
      "a comment before the modifier",
      "\n  /** @ts-ignore Cast variance */\n  out Output = unknown",
    ],
    ["a comment after the parameter", "out Output = unknown /* first */"],
  ])("is silent for %s", async (_label, first) => {
    expect(await errorsOf(listOf(first))).toEqual([])
  })

  it.each([
    ["a repeated modifier", "out out Output = unknown"],
    ["`in` after `out`", "out in Output = unknown"],
    ["a word that is not a modifier", "foo Output = unknown"],
  ])("reports %s, and only that parameter", async (_label, first) => {
    expect(await errorsOf(listOf(first))).toEqual(["1:20 syntax error"])
  })

  it("reports every modifier in a method's list", async () => {
    const source = listOf("out Output = unknown", "export class F { m<", ">() {} }")
    expect(await errorsOf(source)).toHaveLength(3)
  })
})

describe("a `.tsx` file, whose grammar has the same gap", () => {
  const TSX = "src/a.tsx"

  it.each([
    ["`out` on an interface", "export interface A<out T> { v: T }"],
    [
      "the list where the modifier is the ERROR",
      "export interface A<out Output = unknown, out Input = unknown, out Internals extends Base<Output, Input> = Base<Output, Input>> {}",
    ],
    ["a class expression", "export const Q = class<out T> {}"],
  ])("is silent for %s", async (_label, source) => {
    expect(await errorsOf(source, TSX)).toEqual([])
  })

  it("reports a repeated modifier", async () => {
    expect(await errorsOf("export interface A<out out T> { v: T }", TSX)).toEqual([
      "1:24 syntax error",
    ])
  })

  it("keeps the JSX `&` rule and this one apart in a file that has both", async () => {
    // Neither can take the other's ERROR: the `&` rule needs an ampersand-led run under JSX, and
    // this one a run of identifiers in a type parameter list.
    const both = "export interface A<out T> { v: T }\nexport const C = () => <div>a & b</div>"
    expect(await errorsOf(both, TSX)).toEqual([])
    expect(await errorsOf(both.replace("a & b", "a & } b"), TSX)).toEqual(["2:31 syntax error"])
  })
})

describe("a file `tsc`'s parser rejects still reports", () => {
  it.each([
    ["a repeated modifier", "export interface A<out out T> { v: T }"],
    ["`in` repeated", "export interface B<in in T> { v: T }"],
    ["`in` after `out`", "export interface C<out in T> { v: T }"],
    ["two names after a modifier", "export interface D<out T U> { v: T }"],
    ["two names and no modifier", "export interface E<T U> { v: T }"],
    ["an array type for a name", "export interface K<out T[]> { v: T }"],
    ["a stray token after a modifier", "export interface L<out ?> { v: unknown }"],
    ["a stray token after `in out`", "export interface M<in out *> { v: unknown }"],
    [
      "a name between a modifier's constraint and its default",
      "export interface N<out extends X Y = Z> { v: Y }",
    ],
    ["a modifier on a method's type parameter", "export class F { m<in T>(t: T) {} }"],
    ["a modifier on a function's type parameter", "export function g<out T>(t: T) {}"],
    ["a truncation after a modifier", "export interface H<out T> { v: T"],
  ])("reports %s", async (_label, source) => {
    expect(await errorsOf(source)).not.toEqual([])
  })

  // Each of these is the only case that keeps one branch of the rule honest, so the errors are
  // pinned rather than merely present: one more incidental error would otherwise hide a regression.
  it("reports a name after a modifier's constraint, where the parameter already closed", async () => {
    expect(await errorsOf("export interface I<out extends X T> { v: T }")).toEqual([
      "1:34 syntax error",
    ])
  })

  it("reports a name between a constraint and a default, outside the parameter's head", async () => {
    expect(await errorsOf("export interface O<out T extends X Y = Z> { v: T }")).toEqual([
      "1:36 syntax error",
    ])
  })

  it("reports a name after a constraint, and the modifier's error in the same parameter", async () => {
    // A stray piece after the parameter closed refuses the whole parameter, not only itself.
    expect(await errorsOf("export interface J<out T extends X Y> { v: T }")).toEqual([
      "1:24 syntax error",
      "1:36 syntax error",
    ])
  })

  it.each([
    ["`in`", "export interface A<out in> { v: number }"],
    ["`in`, after `in`", "export interface A<in in> { v: number }"],
    ["`this`", "export interface A<out this> { v: number }"],
    ["`typeof`", "export interface A<out typeof> { v: number }"],
    ["`void`", "export interface A<out void> { v: number }"],
    ["`yield`", "export interface A<out yield> { v: number }"],
    ["`interface`", "export interface A<out interface> { v: number }"],
    ["`await`", "export interface A<out await> { v: number }"],
    ["`any`", "export interface A<out any> { v: number }"],
    ["`never`, on a class", "export class A<out never> { v!: number }"],
    ["`in`, on a type alias", "export type A<out in> = { v: number }"],
  ])("reports a modifier before a name `tsc` refuses: %s", async (_label, source) => {
    // `<out in>` and `<in in>` are the likely typos for `<in out T>`.
    expect(await errorsOf(source)).not.toEqual([])
  })

  it.each([
    ["`const out` on an interface", "export interface A<const out T> { v: T }"],
    ["`out const` on an interface", "export interface A<out const T> { v: T }"],
    ["`in const out` on an interface", "export interface A<in const out T> { v: T }"],
    ["`const out` on a type alias", "export type S<const out T> = { v: T }"],
  ])("reports %s, where `const` is refused (TS1277)", async (_label, source) => {
    expect(await errorsOf(source)).not.toEqual([])
  })

  it("drops only the modifier's own error in a file that also has a real one", async () => {
    // The modifier on line 1 is the grammar's; the unclosed call on line 2 is the file's.
    expect(await errorsOf("export interface A<out T> { v: T }\nexport const b = f(")).toEqual([
      "2:1 syntax error",
    ])
  })

  it("is counted the same way where the file is parsed twice for an `import(…)` type", async () => {
    // `repairedOrFirst` keeps the reparse only when it has fewer errors, counted by the same
    // `collectParseErrors`, so both trees have to drop the modifier alike.
    const withImport = 'type T = import("./m").X\nexport interface A<out U> { v: U }'
    expect(await errorsOf(withImport)).toEqual([])
    expect(await errorsOf(`${withImport}\nexport const b = f(`)).toEqual(["3:1 syntax error"])
  })
})

describe("the Symbols are the same with the modifiers as without them", () => {
  const WITH_MODIFIERS = [
    "export interface A<out T = unknown> { v: T; f(x: T): void }",
    "export class E<in out T> {",
    "  m<U>(u: U, t: T) { inner(u) }",
    "}",
    "export type F<out T extends object = {}> = (t: T) => T",
    "export interface Z<out Output = unknown, out Input = unknown, out I extends B<Output> = B<Input>> {",
    "  v: Output",
    "}",
    "export function after() { post() }",
    "",
  ].join("\n")

  const WITHOUT_MODIFIERS = WITH_MODIFIERS.replaceAll("<out ", "<")
    .replaceAll("<in out ", "<")
    .replaceAll(", out ", ", ")

  async function shapeOf(source: string) {
    return (await symbolsOf(source)).map((s) => ({
      id: s.id,
      kind: s.kind,
      visibility: s.visibility,
      derivedBy: s.derivedBy,
      signature: s.signature,
      lines: [s.source.startLine, s.source.endLine],
    }))
  }

  /** A class's string less its head: with its body as its full node, no head is read. */
  function bodyOf(symbol: SymbolCandidate<Node>): string {
    if (symbol.bodyNode === null) throw new Error(`${symbol.id} has no body`)
    return normalizeAst({ ...symbol, fullNode: symbol.bodyNode })
  }

  it("parses the twin cleanly, so the comparison is against a tree with no error in it", async () => {
    expect(WITHOUT_MODIFIERS).not.toMatch(/\b(in|out) /)
    expect(await errorsOf(WITHOUT_MODIFIERS)).toEqual([])
    expect(await errorsOf(WITH_MODIFIERS)).toEqual([])
  })

  it("extracts the same ids, kinds and signatures, through both recovery shapes", async () => {
    // A class, an interface and a type alias carry no `Signature`, so the parameter name the
    // grammar misread has no field to reach; a method's own type parameters come from its own
    // list, which the modifier never touches. `Z` is the list where the modifier is the ERROR.
    const shape = await shapeOf(WITH_MODIFIERS)
    expect(shape.map((s) => s.id)).toEqual([
      "ts:src/a.ts#A",
      "ts:src/a.ts#E",
      "ts:src/a.ts#E.m",
      "ts:src/a.ts#F",
      "ts:src/a.ts#Z",
      "ts:src/a.ts#after",
    ])
    expect(shape.find((s) => s.id.endsWith("#E.m"))?.signature?.typeParameters).toEqual(["U"])
    expect(shape).toEqual(await shapeOf(WITHOUT_MODIFIERS))
  })

  it("serialises an interface the same, since only its body is read", async () => {
    // The equality is a known gap, not the rule: an interface's type parameters and `extends`
    // sit beside its body, as a class's head does, and it has no signature either, so they reach
    // no axis. LP8p closes that for a class and records the interface as still open.
    const withAst = (await symbolsOf(WITH_MODIFIERS)).filter((s) => s.kind === "interface")
    const withoutAst = (await symbolsOf(WITHOUT_MODIFIERS)).filter((s) => s.kind === "interface")
    expect(withAst.map(normalizeAst)).toEqual(withoutAst.map(normalizeAst))
  })

  it("serialises a class's body the same, and its head as the grammar recovered it", async () => {
    // A class's head reaches its string (LP8p), so the two strings differ — but as a
    // grammar-recovery artifact, not because a variance modifier is read: recovery takes `in`
    // for the parameter's name and leaves `out T` in an ERROR that `serialize` drops (LP27c).
    // A grammar that learns the rule changes this head again.
    const E = "ts:src/a.ts#E"
    const withModifiers = await symbolOf(WITH_MODIFIERS, E)
    const withoutModifiers = await symbolOf(WITHOUT_MODIFIERS, E)
    const body = bodyOf(withModifiers)
    expect(bodyOf(withoutModifiers)).toBe(body)
    expect(normalizeAst(withModifiers)).toBe(
      `${body} (type_parameters "<" (type_parameter (type_identifier "in")) ">")`,
    )
    expect(normalizeAst(withoutModifiers)).toBe(
      `${body} (type_parameters "<" (type_parameter (type_identifier "T")) ">")`,
    )
  })

  it("keeps the calls inside and after the annotated declaration", async () => {
    expect(await callsOf(WITH_MODIFIERS, "ts:src/a.ts#E.m")).toEqual(["inner"])
    expect(await callsOf(WITH_MODIFIERS, "ts:src/a.ts#after")).toEqual(["post"])
  })
})

describe("where the rule stops", () => {
  it("still needs the filter: the grammar has no rule for a variance modifier yet", async () => {
    // Every case above would stay green if the grammar learned variance annotations, and the rule
    // would be dead code without a test noticing. This is the one that will say so.
    const { tree } = await parseSource("export interface A<out T> { v: T }")
    expect(tree?.rootNode.hasError).toBe(true)
  })

  it.each([
    ["a type alias whose right-hand side is not an object type", "export type A<out T> = T"],
    ["a union", "export type H<out T> = T | Promise<T>"],
    ["`in out` before a parameter named `out`", "export interface Z<in out> { v: out }"],
  ])("drops the modifier on %s, which only `tsc`'s checker refuses", async (_label, source) => {
    // TS2637 and TS2636 come from the checker: `tsc`'s parser reads these files, so the ERROR is
    // the grammar's alone. The rule does not read an alias's right-hand side.
    expect(await errorsOf(source)).toEqual([])
  })

  const astOf = async (source: string) => {
    const [symbol] = await symbolsOf(source)
    if (symbol === undefined) throw new Error("no Symbol in fixture")
    return normalizeAst(symbol)
  }

  it("cannot tell an annotated type alias's parameters apart in `normalizeAst`", async () => {
    // The alias is serialised whole, and the grammar reads `out` as the parameter's name and
    // leaves the real one in an ERROR that `serialize` skips. That predates the rule; what the
    // rule adds is that the file no longer says it is doubtful. The unannotated twins differ.
    expect(await astOf("export type F<out T> = () => void")).toBe(
      await astOf("export type F<out U> = () => void"),
    )
    expect(await astOf("export type F<T> = () => void")).not.toBe(
      await astOf("export type F<U> = () => void"),
    )
  })

  it("cannot tell an annotated class's parameters apart in `normalizeAst` either", async () => {
    // A class's type parameters reach its string with the rest of its head (LP8p), through the
    // same `serialize`, so they inherit the alias's misread: where the body does not name the
    // parameter, renaming it changes nothing, and `fingerprint.md` S4 does not hold for a
    // variance-annotated class. The unannotated twins differ.
    expect(await astOf("export class E<in out T> { m() {} }")).toBe(
      await astOf("export class E<in out U> { m() {} }"),
    )
    expect(await astOf("export class E<T> { m() {} }")).not.toBe(
      await astOf("export class E<U> { m() {} }"),
    )
  })
})
