import type { Signature } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { symbolOf } from "./fixtures/ctx"

/**
 * What a caller sees of a parameter's form is recorded in fields of its own: `optional` for an
 * optional or defaulted parameter, `rest` for a rest one, each written only when true. `name`
 * is the bare binding and `type` the annotation alone (LP11b). A binding that destructures
 * also lists the names it binds, in `bindings` (LP11d).
 */

type Input = Signature["inputs"][number]

/** A declaration whose parameter list is `params`, and the id of the Symbol it declares. */
type Host = (params: string) => [source: string, id: string]

const inFunction: Host = (params) => [`export function f(${params}) {}`, "ts:src/a.ts#f"]
const inMethod: Host = (params) => [`export class C {\n  m(${params}) {}\n}`, "ts:src/a.ts#C.m"]
const inArrow: Host = (params) => [`export const g = (${params}) => 0`, "ts:src/a.ts#g"]

async function inputsOf(params: string, host: Host = inFunction): Promise<Input[] | undefined> {
  const [source, id] = host(params)
  return (await symbolOf(source, id)).signature?.inputs
}

const FORMS: Array<[string, string, Input]> = [
  ["a required parameter", "a: string", { name: "a", type: "string" }],
  ["an optional parameter", "a?: string", { name: "a", type: "string", optional: true }],
  ["an untyped optional parameter", "a?", { name: "a", type: "", optional: true }],
  [
    "a defaulted parameter",
    "limit: number = 10",
    { name: "limit", type: "number", optional: true },
  ],
  ["an untyped defaulted parameter", "limit = 10", { name: "limit", type: "", optional: true }],
  ["a rest parameter", "...ids: string[]", { name: "ids", type: "string[]", rest: true }],
  ["an untyped rest parameter", "...ids", { name: "ids", type: "", rest: true }],
  [
    "a destructured rest parameter",
    "...[p, q]: T",
    { name: "[p, q]", type: "T", rest: true, bindings: ["p", "q"] },
  ],
  [
    "a defaulted destructured parameter",
    "{ x }: Opts = {}",
    { name: "{ x }", type: "Opts", optional: true, bindings: ["x"] },
  ],
  [
    "an untyped defaulted destructured parameter",
    "{ a } = {}",
    { name: "{ a }", type: "", optional: true, bindings: ["a"] },
  ],
  ["a `this` parameter", "this: Foo", { name: "this", type: "Foo" }],
  [
    "a decorated optional parameter",
    "@Query() q?: string",
    { name: "q", type: "string", optional: true },
  ],
  [
    "a decorated defaulted parameter property",
    "@Inject() private x = 5",
    { name: "x", type: "", optional: true },
  ],
  ["a parameter property", "private readonly x: T", { name: "x", type: "T" }],
  [
    "an optional parameter property",
    "public override readonly y?: T",
    { name: "y", type: "T", optional: true },
  ],
]

describe("readParameters — the form of a parameter", () => {
  describe.each([
    ["a function", inFunction],
    ["a class method", inMethod],
    ["an arrow", inArrow],
  ])("in %s", (_host, host) => {
    it.each(FORMS)("records %s", async (_label, params, expected) => {
      expect(await inputsOf(params, host)).toEqual([expected])
    })
  })

  it("marks an optional parameter and a defaulted one alike, since a caller may omit either", async () => {
    expect(await inputsOf("a?: string")).toEqual(await inputsOf('a: string = "x"'))
  })

  it("reads an abstract method's parameters", async () => {
    const source = "export abstract class A {\n  abstract m(a?: string, ...ids: string[]): void\n}"
    const symbol = await symbolOf(source, "ts:src/a.ts#A.m")
    expect(symbol.signature?.inputs).toEqual([
      { name: "a", type: "string", optional: true },
      { name: "ids", type: "string[]", rest: true },
    ])
  })

  it("reads an ambient method's parameters", async () => {
    const source = "export declare class D {\n  m(limit?: number, ...rest: T[]): void\n}"
    const symbol = await symbolOf(source, "ts:src/a.ts#D.m")
    expect(symbol.signature?.inputs).toEqual([
      { name: "limit", type: "number", optional: true },
      { name: "rest", type: "T[]", rest: true },
    ])
  })
})

/**
 * A recovered parse can leave a parameter with no binding the source wrote: a zero-width
 * MISSING identifier, or an ERROR node where the binding would be. A MISSING node is not
 * written (fingerprint.md §5.1(6)), so the name is the nearest text that was — and never the
 * empty string the schema's `minLength: 1` refuses (LP11c).
 */
const REPAIRED: Array<[source: string, id: string, expected: Input]> = [
  ["function f(...: string[]) {}", "ts:src/a.ts#f", { name: "...", type: "string[]", rest: true }],
  ["function f(...,) {}", "ts:src/a.ts#f", { name: "...", type: "", rest: true }],
  ["class C { m(...: T) {} }", "ts:src/a.ts#C.m", { name: "...: T", type: "", rest: true }],
  [
    "function f(?: string) {}",
    "ts:src/a.ts#f",
    { name: "?: string", type: "string", optional: true },
  ],
]

describe("readParameters — a parameter the parser repaired", () => {
  it.each(REPAIRED)("names the parameter in %j", async (source, id, expected) => {
    const symbol = await symbolOf(source, id)
    expect(symbol.signature?.inputs).toEqual([expected])
  })
})
