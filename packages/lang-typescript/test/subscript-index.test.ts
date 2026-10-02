import { describe, expect, it } from "vitest"
import { walkFirstSymbol } from "./fixtures/ctx"

/**
 * A returned bracket access is trivial only when both its object and its index are
 * (`drop-list.md` §5.5, T13–T15), and triviality decides only whether the `return` is a rule:
 * a call written in the index is recorded either way.
 */

async function walked(body: string) {
  const { rules, calls } = await walkFirstSymbol(`export async function f(x: any) { ${body} }`)
  return { returns: rules.map((r) => r.expr), calls: calls.map((c) => c.target) }
}

describe("a returned subscript", () => {
  it.each([
    ["a literal index", "return items[0]"],
    ["an identifier index", "return map[x]"],
    ["a member index", "return map[x.key]"],
  ])("is trivial with %s", async (_label, body) => {
    expect(await walked(body)).toEqual({ returns: [], calls: [] })
  })

  it.each([
    ["a call", "return cache[computeKey(x)]", ["cache[computeKey(x)]"], ["computeKey"]],
    [
      "a call under a negation",
      "return !flags[flagName(x)]",
      ["!flags[flagName(x)]"],
      ["flagName"],
    ],
    [
      "an awaited call under a member",
      "return this.table[await loadIndex(x)].value",
      ["this.table[await loadIndex(x)].value"],
      ["loadIndex"],
    ],
    [
      "a database read",
      "return LABELS[await prisma.user.count()]",
      ["LABELS[await prisma.user.count()]"],
      ["prisma.user.count"],
    ],
  ])("records the return and the call when the index is %s", async (_label, body, returns, calls) => {
    expect(await walked(body)).toEqual({ returns, calls })
  })

  it("records the same call whether or not it is hoisted into a local", async () => {
    const inline = await walked("return cache[computeKey(x)]")
    const hoisted = await walked("const k = computeKey(x)\n  return cache[k]")
    expect(inline.calls).toEqual(hoisted.calls)
  })
})
