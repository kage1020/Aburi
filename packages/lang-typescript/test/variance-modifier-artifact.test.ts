import { describe, expect, it } from "vitest"
import { callsOf, parseSource, symbolsOf } from "./fixtures/ctx"

/**
 * The typescript grammar has no rule for TypeScript 4.7's `in` / `out` variance modifiers, so
 * `interface A<out T>` was a parse error in a file `tsc` accepts. Recovery usually reads the first
 * modifier as the parameter's name and leaves the rest in an ERROR, but in some longer lists it
 * makes the modifier itself the ERROR instead. 0.3.1 is the newest `@vscode/tree-sitter-wasm`, so
 * a fix is not a version bump away.
 *
 * `collectParseErrors` drops exactly that shape (`lang-plugin.md` LP27c). As with the JSX `&`,
 * these suites hold both halves of why that is safe: a file `tsc` rejects still reports, and
 * the Symbols come out the same with the modifiers as without them.
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
    ["a modifier on a later parameter", "export interface J<A, out B> { a: A; b: B }"],
    ["a modifier on every parameter", "export interface K<out T, in U> { f(u: U): T }"],
    ["`in out` beside a `const` parameter", "export type L<in out T, const U> = { v: T }"],
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
    ["`in` on a parameter named `out`", "export interface Z<in out> { v: out }"],
  ])("%s", async (_label, source) => {
    expect(await errorsOf(source)).toEqual([])
  })

  it("is silent in a `.tsx` file too, whose grammar has the same gap", async () => {
    expect(await errorsOf("export interface A<out T> { v: T }", "src/a.tsx")).toEqual([])
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

  it("is the shape this fixture gets", async () => {
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

describe("a file `tsc` rejects still reports", () => {
  it.each([
    ["a repeated modifier", "export interface A<out out T> { v: T }"],
    ["`in` repeated", "export interface B<in in T> { v: T }"],
    ["`in` after `out`", "export interface C<out in T> { v: T }"],
    ["two names after a modifier", "export interface D<out T U> { v: T }"],
    ["two names and no modifier", "export interface E<T U> { v: T }"],
    ["a name after a modifier's constraint", "export interface I<out extends X T> { v: T }"],
    ["a name after a constraint", "export interface J<out T extends X Y> { v: T }"],
    [
      "a name between a constraint and a default",
      "export interface O<out T extends X Y = Z> { v: T }",
    ],
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

  it("drops only the modifier's own error in a file that also has a real one", async () => {
    // The modifier on line 1 is the grammar's; the unclosed call on line 2 is the file's.
    expect(await errorsOf("export interface A<out T> { v: T }\nexport const b = f(")).toEqual([
      "2:1 syntax error",
    ])
  })
})

describe("the Symbols are the same with the modifiers as without them", () => {
  const WITH_MODIFIERS = [
    "export interface A<out T = unknown> { v: T; f(x: T): void }",
    "export class E<in out T> {",
    "  m<U>(u: U, t: T) { inner(u) }",
    "}",
    "export type F<out T extends object = {}> = (t: T) => T",
    "export function after() { post() }",
    "",
  ].join("\n")

  const WITHOUT_MODIFIERS = WITH_MODIFIERS.replaceAll("<out ", "<").replaceAll("<in out ", "<")

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

  it("parses the twin cleanly, so the comparison is against a tree with no error in it", async () => {
    expect(WITHOUT_MODIFIERS).not.toContain("out ")
    expect(await errorsOf(WITHOUT_MODIFIERS)).toEqual([])
    expect(await errorsOf(WITH_MODIFIERS)).toEqual([])
  })

  it("extracts the same ids, kinds and signatures", async () => {
    // A class, an interface and a type alias carry no `Signature`, so the parameter name the
    // grammar misread has no field to reach; a method's own type parameters come from its own
    // list, which the modifier never touches.
    const shape = await shapeOf(WITH_MODIFIERS)
    expect(shape.map((s) => s.id)).toEqual([
      "ts:src/a.ts#A",
      "ts:src/a.ts#E",
      "ts:src/a.ts#E.m",
      "ts:src/a.ts#F",
      "ts:src/a.ts#after",
    ])
    expect(shape.find((s) => s.id.endsWith("#E.m"))?.signature?.typeParameters).toEqual(["U"])
    expect(shape).toEqual(await shapeOf(WITHOUT_MODIFIERS))
  })

  it("keeps the calls inside and after the annotated declaration", async () => {
    expect(await callsOf(WITH_MODIFIERS, "ts:src/a.ts#E.m")).toEqual(["inner"])
    expect(await callsOf(WITH_MODIFIERS, "ts:src/a.ts#after")).toEqual(["post"])
  })
})
