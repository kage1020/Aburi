import type { Signature } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { symbolOf } from "./fixtures/ctx"

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
      expect(await inputsOf(params, host)).toStrictEqual([expected])
    })
  })

  it("marks an optional parameter and a defaulted one alike, since a caller may omit either", async () => {
    expect(await inputsOf("a?: string")).toStrictEqual(await inputsOf('a: string = "x"'))
  })

  it("reads an abstract method's parameters", async () => {
    const source = "export abstract class A {\n  abstract m(a?: string, ...ids: string[]): void\n}"
    const symbol = await symbolOf(source, "ts:src/a.ts#A.m")
    expect(symbol.signature?.inputs).toStrictEqual([
      { name: "a", type: "string", optional: true },
      { name: "ids", type: "string[]", rest: true },
    ])
  })

  it("reads an ambient method's parameters", async () => {
    const source = "export declare class D {\n  m(limit?: number, ...rest: T[]): void\n}"
    const symbol = await symbolOf(source, "ts:src/a.ts#D.m")
    expect(symbol.signature?.inputs).toStrictEqual([
      { name: "limit", type: "number", optional: true },
      { name: "rest", type: "T[]", rest: true },
    ])
  })
})

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
    expect(symbol.signature?.inputs).toStrictEqual([expected])
  })
})
