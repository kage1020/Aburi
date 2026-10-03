import { describe, expect, it } from "vitest"
import { walkFirstSymbol } from "./fixtures/ctx"

/**
 * A returned bracket access is trivial only when its object and its index both are
 * (`drop-list.md` §5.5; T13–T19 in §8.5). Only the object used to be checked, and a trivial
 * return is never walked — `handleReturnStatement` returns before the walk that collects calls —
 * so a call in a trivially read index was in no Symbol at all. `return cache[computeKey(key)]`
 * recorded no `computeKey`, and `return LABELS[await prisma.user.count()]` put the database read
 * in neither `calls[]` nor `effects[]`, so an edit to it was reported as a syntax-only change. The
 * index is therefore part of the determination. A concise arrow body is walked whole and always
 * recorded the call; the block spelling now agrees with it.
 *
 * The symptom as a user met it is the last test here: the call was missing while it was written
 * in the index and appeared once it was hoisted into a local. Each rule is asserted with its
 * `type` and its exact `expr`, not merely counted, because the `expr` is what moves the Symbol's
 * `logic` fingerprint.
 *
 * What stays trivial is pinned on both operands — `this` or a member chain as the object, `?.`
 * before the bracket, an index that is a type wrapper around a name — and so is what does not: a
 * call in the object, an index that awaits a value without calling anything, and a template
 * literal, which is never trivial, so `` a[`k`] `` is a rule where `a["k"]` is not. A type
 * wrapper is read through in an index only; `return x as T` is still a rule.
 */

async function walked(body: string) {
  const { rules, calls } = await walkFirstSymbol(`export async function f(x: any) { ${body} }`)
  return { rules: rules.map((r) => [r.type, r.expr]), calls: calls.map((c) => c.target) }
}

describe("a returned subscript", () => {
  it.each([
    ["a literal index", "return items[0]"],
    ["an identifier index", "return map[x]"],
    ["a member index", "return map[x.key]"],
    ["a trivial bracket access as the index", "return a[b[c]]"],
    ["an update as the index", "return a[i++]"],
    ["`this` and a member under the object", "return this.items[0]"],
    ["a member chain as the object", "return a.b[x]"],
    ["optional chaining", "return a?.[x]"],
    ["an `as` around the index", "return a[i as number]"],
    ["a non-null assertion around the index", "return a[i!]"],
    ["an old-style assertion around the index", "return a[<number>i]"],
    ["a `satisfies` around the index", "return a[k satisfies string]"],
    ["a `keyof` assertion around the index", "return obj[key as keyof T]"],
    ["a parenthesized assertion around the index", "return a[(i as number)]"],
  ])("is trivial with %s", async (_label, body) => {
    expect(await walked(body)).toEqual({ rules: [], calls: [] })
  })

  it.each([
    ["a call", "return cache[computeKey(x)]", "cache[computeKey(x)]", ["computeKey"]],
    ["a call under a negation", "return !flags[flagName(x)]", "!flags[flagName(x)]", ["flagName"]],
    [
      "an awaited call under a member",
      "return this.table[await loadIndex(x)].value",
      "this.table[await loadIndex(x)].value",
      ["loadIndex"],
    ],
    [
      "a database read",
      "return LABELS[await prisma.user.count()]",
      "LABELS[await prisma.user.count()]",
      ["prisma.user.count"],
    ],
    ["a call after optional chaining", "return a?.[g(x)]", "a?.[g(x)]", ["g"]],
    ["a call under an `as`", "return a[g() as number]", "a[g() as number]", ["g"]],
    ["a call in the object", "return g()[x]", "g()[x]", ["g"]],
    [
      "a call in the object, with a literal index",
      "return makeCache()[0]",
      "makeCache()[0]",
      ["makeCache"],
    ],
    ["a conditional", "return a[x ? y : z]", "a[x ? y : z]", []],
    ["a substituting template", `return a[\`t\${x}\`]`, `a[\`t\${x}\`]`, []],
    ["a template without a substitution", "return a[`k`]", "a[`k`]", []],
    ["an awaited value", "return a[await p]", "a[await p]", []],
  ])("is a return rule, with its calls recorded, given %s", async (_label, body, expr, calls) => {
    expect(await walked(body)).toEqual({ rules: [["return", expr]], calls })
  })

  it("reads a type wrapper through in an index only, so a returned assertion is a rule", async () => {
    expect(await walked("return x as number")).toEqual({
      rules: [["return", "x as number"]],
      calls: [],
    })
  })

  it("records the same call whether or not it is hoisted into a local", async () => {
    const inline = await walked("return cache[computeKey(x)]")
    const hoisted = await walked("const k = computeKey(x)\n  return cache[k]")
    expect(inline.calls).toEqual(["computeKey"])
    expect(hoisted.calls).toEqual(["computeKey"])
  })
})
