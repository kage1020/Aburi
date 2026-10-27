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

describe("a type is recorded as it reads on one line", () => {
  it.each([
    [
      "a union broken with a leading operator",
      "(\n  provider:\n    | ClassProvider\n    | FactoryProvider,\n) {}",
      ["ClassProvider | FactoryProvider"],
    ],
    [
      "a union broken inside a generic argument",
      "(\n  parts: Array<\n    | A\n    | B\n  >,\n) {}",
      ["Array<A | B>"],
    ],
    ["a union broken inside parentheses", "(xs: (\n  | A\n  | B\n)[]) {}", ["(A | B)[]"]],
    [
      "a leading operator in each of two arguments",
      "(x: Map<| A | B, | C | D>) {}",
      ["Map<A | B, C | D>"],
    ],
    ["an intersection broken after each operator", "(x: A &\n  B &\n  C) {}", ["A & B & C"]],
    ["an intersection with a leading operator", "(): & Base & Extra {}", ["Base & Extra"]],
    ["a type argument list broken over lines", "(m: Map<\n  K,\n  V\n>) {}", ["Map<K, V>"]],
    [
      "a function type's parameters broken with a trailing comma",
      "(handler: (\n  req: Request,\n  res: Response,\n) => void) {}",
      ["(req: Request, res: Response) => void"],
    ],
    ["a tuple broken with a trailing comma", "(pair: [\n  A,\n  B,\n]) {}", ["[A, B]"]],
    ["an object type broken over lines", "(o: {\n  a: A\n  b?: B\n}) {}", ["{ a: A; b?: B }"]],
    ["an object type's members separated by commas", "(o: { a: A, b: B, }) {}", ["{ a: A; b: B }"]],
    ["a type predicate", "(x: unknown): x is | A | B {}", ["unknown", "x is A | B"]],
    ["a function type's return", "(load: () => | A | B) {}", ["() => A | B"]],
    [
      "a type parameter's constraint and default",
      "<T extends | A = | B>() {}",
      ["T extends A = B"],
    ],
    ["a comment between the colon and the type", "(x: /* c */ | A | B) {}", ["A | B"]],
    [
      "a line comment above a broken union",
      "(\n  x:\n    // the class form\n    | A\n    | B,\n) {}",
      ["A | B"],
    ],
    ["a comment inside a type", "(x: A | /* legacy */ B) {}", ["A | B"]],
    ["a comment before a return type", "(): /* c */ Foo {}", ["Foo"]],
    ["a `,` and a `|` inside a string type", '(x: "a, | b" | C) {}', ['"a, | b" | C']],
    ["the layout inside a template literal type", `(x: \`a \${ B }  c\`) {}`, [`\`a \${ B }  c\``]],
    ["an operator the parser gave no operand", "(x: |) {}", ["|"]],
  ])("records %s", async (_label, written, recorded) => {
    const signature = await signatureOf(`export function f${written}`)

    expect([
      ...(signature?.typeParameters ?? []),
      ...(signature?.inputs ?? []).map((i) => i.type),
      ...(signature?.outputs ?? []),
    ]).toEqual(recorded)
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
