import { describe, expect, it } from "vitest"
import { normalizeAst } from "../src/index"
import { normalizedOf, symbolOf } from "./fixtures/ctx"

const stringOf = (source: string, id = "ts:src/a.ts#C") => normalizedOf(source, id)

const BODY = "{ run() { go() } }"

describe("normalizeAst — a class's head", () => {
  it.each([
    [
      "a re-parent",
      `export class C extends Base ${BODY}`,
      `export class C extends Audited ${BODY}`,
    ],
    ["dropping extends", `export class C extends Base ${BODY}`, `export class C ${BODY}`],
    [
      "swapping the interface it implements",
      `export class C implements Reader ${BODY}`,
      `export class C implements Writer ${BODY}`,
    ],
    [
      "a new type parameter",
      `export class C<T> ${BODY}`,
      `export class C<T, K extends keyof T> ${BODY}`,
    ],
    ["dropping abstract", `export abstract class C ${BODY}`, `export class C ${BODY}`],
    [
      "a re-parent of a class merged behind an interface",
      `export interface C { z: number }\nexport class C extends Base ${BODY}`,
      `export interface C { z: number }\nexport class C extends Audited ${BODY}`,
    ],
    [
      "adding abstract to a class merged behind an interface",
      `export interface C { z: number }\nexport class C ${BODY}`,
      `export interface C { z: number }\nexport abstract class C ${BODY}`,
    ],
  ])("changes the string for %s", async (_label, before, after) => {
    expect(await stringOf(after)).not.toBe(await stringOf(before))
  })

  it("changes the string for a re-parent of an anonymous default class, an expression node", async () => {
    const id = "ts:src/a.ts#<default>"
    expect(await stringOf(`export default class extends Audited ${BODY}`, id)).not.toBe(
      await stringOf(`export default class extends Base ${BODY}`, id),
    )
  })

  it("follows the body with the head, in the order the declaration writes it", async () => {
    const source = `export abstract class C<T> extends Base<T> implements Reader, Writer ${BODY}`
    expect(await stringOf(source)).toBe(
      [
        '(class_body (method_definition (property_identifier "run") (formal_parameters) (statement_block (expression_statement (call_expression (identifier "go") (arguments))))))',
        '"abstract"',
        '(type_parameters "<" (type_parameter (type_identifier "T")) ">")',
        '(class_heritage (extends_clause "extends" (identifier "Base") (type_arguments "<" (type_identifier "T") ">")) (implements_clause "implements" (type_identifier "Reader") (type_identifier "Writer")))',
      ].join(" "),
    )
  })

  it("leaves a class with no head described by its body alone", async () => {
    const symbol = await symbolOf(`export class C ${BODY}`, "ts:src/a.ts#C")
    if (symbol.bodyNode === null) throw new Error("class body missing")
    const bodyOnly = normalizeAst({ ...symbol, fullNode: symbol.bodyNode })
    expect(normalizeAst(symbol)).toBe(bodyOnly)
  })
})
