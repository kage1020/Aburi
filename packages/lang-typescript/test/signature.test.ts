import { describe, expect, it } from "vitest"
import { symbolOf } from "./fixtures/ctx"

const signatureOf = async (source: string, id = "ts:src/a.ts#f") =>
  (await symbolOf(source, id)).signature

describe("what a function's signature records", () => {
  it.each([
    ["an async function", "export async function f() {}", { async: true, generator: false }],
    ["an async arrow", "export const f = async (x) => x + 1", { async: true, generator: false }],
    [
      "a parenthesis-free async arrow",
      "export const f = async x => x + 1",
      { async: true, generator: false },
    ],
    ["an arrow that is not async", "export const f = (x) => x + 1", { async: false }],
    ["a generator", "export function* f() {}", { async: false, generator: true }],
    [
      "parameters and a return type",
      "export function f(a: number, b: string): boolean { return true }",
      {
        inputs: [
          { name: "a", type: "number" },
          { name: "b", type: "string" },
        ],
        outputs: ["boolean"],
      },
    ],
    ["no return type", "export function f() {}", { outputs: [] }],
    [
      "each type parameter's text, constraint and default included",
      "export function f<T, K extends Base, V = string>() {}",
      { typeParameters: ["T", "K extends Base", "V = string"] },
    ],
  ])("records %s", async (_label, source, expected) => {
    expect(await signatureOf(source)).toMatchObject(expected)
  })
})

describe("a type broken over lines with a leading operator", () => {
  const broken = [
    "export function f(",
    "  provider:",
    "    | ClassProvider",
    "    | FactoryProvider,",
    "  parts: Array<",
    "    | A",
    "    | B",
    "  >,",
    "): & Base & Extra {}",
  ].join("\n")

  it("is recorded as the operator-free spelling", async () => {
    const signature = await signatureOf(broken)

    expect(signature?.inputs.map((i) => i.type)).toEqual([
      "ClassProvider\n    | FactoryProvider",
      "Array<\n    A\n    | B\n  >",
    ])
    expect(signature?.outputs).toEqual(["Base & Extra"])
  })

  it.each([
    ["a parameter", "(x: | A | B) {}", "(x: A | B) {}"],
    ["a return type", "(): | A | B {}", "(): A | B {}"],
    ["a generic argument", "(x: Map<string, | A | B>) {}", "(x: Map<string, A | B>) {}"],
    ["an intersection", "(x: & A & B) {}", "(x: A & B) {}"],
    ["a type predicate", "(x: unknown): x is | A | B {}", "(x: unknown): x is A | B {}"],
    ["a function type's return", "(load: () => | A | B) {}", "(load: () => A | B) {}"],
    ["a type parameter's constraint", "<T extends | A | B>() {}", "<T extends A | B>() {}"],
  ])("gives %s the signature it has written on one line", async (_label, leading, joined) => {
    expect(await signatureOf(`export function f${leading}`)).toEqual(
      await signatureOf(`export function f${joined}`),
    )
  })

  it("keeps the characters of a string type", async () => {
    const signature = await signatureOf('export function f(x: "| a" | "& b") {}')

    expect(signature?.inputs.map((i) => i.type)).toEqual(['"| a" | "& b"'])
  })
})

describe("what a function throws", () => {
  it.each([
    ["the constructor of `throw new`", "throw new MyError()", ["MyError"]],
    ["an identifier thrown", "throw err", ["err"]],
    ["the callee of a factory thrown", "throw makeError()", ["makeError"]],
    ["the whole callee of a member factory", "throw errors.gone()", ["errors.gone"]],
    ["nothing for a thrown literal", 'throw "bad"', []],
  ])("records %s", async (_label, statement, throws) => {
    const source = `export function f(err: Error) { ${statement} }`

    expect((await signatureOf(source))?.throws).toEqual(throws)
  })

  it("joins what the body throws with what the JSDoc says, once each and sorted", async () => {
    const source = [
      "/** @throws {NotFound} */",
      "export function f(x: any) {",
      "  if (!x) throw new NotFound()",
      "  throw new BadRequest()",
      "}",
    ].join("\n")

    expect((await signatureOf(source))?.throws).toEqual(["BadRequest", "NotFound"])
  })
})
