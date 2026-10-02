import { describe, expect, it } from "vitest"
import { normalizeAst } from "../src/index"
import { symbolsOf } from "./fixtures/ctx"

/**
 * A class has no signature, so its head — `abstract`, type parameters, `extends`, `implements`
 * — reached no axis: re-parenting a class, dropping `abstract` or adding a required type
 * parameter left every fingerprint identical and the diff reported nothing (LP8p, issue #339).
 */

async function classString(source: string, id = "ts:src/a.ts#C"): Promise<string> {
  const symbol = (await symbolsOf(source)).find((s) => s.id === id)
  if (symbol === undefined) throw new Error(`${id} missing`)
  return normalizeAst(symbol)
}

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
      "another interface",
      `export class C implements Reader ${BODY}`,
      `export class C implements Writer ${BODY}`,
    ],
    [
      "a new type parameter",
      `export class C<T> ${BODY}`,
      `export class C<T, K extends keyof T> ${BODY}`,
    ],
    ["dropping abstract", `export abstract class C ${BODY}`, `export class C ${BODY}`],
  ])("changes the string for %s", async (_label, before, after) => {
    expect(await classString(after)).not.toBe(await classString(before))
  })

  it("leaves a class with no head described by its body alone", async () => {
    const symbol = (await symbolsOf(`export class C ${BODY}`)).find((s) => s.kind === "class")
    if (symbol === undefined || symbol.bodyNode === null) throw new Error("class body missing")
    const bodyOnly = normalizeAst({ ...symbol, kind: "function", fullNode: symbol.bodyNode })
    expect(normalizeAst(symbol)).toBe(bodyOnly)
  })
})
