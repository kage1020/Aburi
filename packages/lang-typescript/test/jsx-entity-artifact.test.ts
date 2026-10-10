import { describe, expect, it } from "vitest"
import { callsOf, parseErrorsOf, symbolsOf } from "./fixtures/ctx"

describe("the grammar's `&` in JSX is not reported as a parse error", () => {
  it.each([
    ["bare, between words", "export const A = () => <p>a & b</p>"],
    ["at the end of the text", "export const G = () => <p>a &</p>"],
    ["doubled", "export const H = () => <p>a && b</p>"],
    ["followed by an assignment", "export const I = () => <p>a &= b</p>"],
    ["in a fragment", "export const J = () => <>a & b</>"],
    [
      "nested one element down",
      "export const K = () => <div><span>Subscription & Billing</span></div>",
    ],
    ["entity-shaped inside an attribute", 'export const D = () => <p title="a&b">x</p>'],
    ["a query string inside an attribute", 'export const E = () => <a href="/x?a=1&b=2">go</a>'],
    ["inside a self-closing element's attribute", 'export const P = () => <img alt="a&b" />'],
  ])("%s", async (_label, source) => {
    expect(await parseErrorsOf(source, "src/a.tsx")).toEqual([])
  })

  it("is silent on `.jsx` too, which routes to the same grammar", async () => {
    expect(await parseErrorsOf("export const A = () => <p>a & b</p>", "src/a.jsx")).toEqual([])
  })

  it.each([
    ["an escaped entity", "src/a.tsx", "export const B = () => <p>a &amp; b</p>"],
    ["a named entity", "src/a.tsx", "export const N = () => <p>a &nbsp; b</p>"],
    [
      "an attribute whose `&` stands alone",
      "src/a.tsx",
      'export const C = () => <p title="a & b">x</p>',
    ],
    ["an interpolated string", "src/a.tsx", 'export const F = () => <p>{"a & b"}</p>'],
    [
      "a bitwise `&` in an expression",
      "src/a.tsx",
      "export const M = ({ a, b }: any) => <p>{a & b}</p>",
    ],
    ["a `.ts` file's bitwise `&`", "src/a.ts", "export const i = (a: number, b: number) => a & b"],
  ])("never reported it for %s either", async (_label, path, source) => {
    expect(await parseErrorsOf(source, path)).toEqual([])
  })
})

describe("a file that really is broken still reports", () => {
  it("reports a truncation that carries an ampersand of its own", async () => {
    expect(await parseErrorsOf("export const U = () => <div><p>a & b</p>", "src/a.tsx")).toEqual([
      "1:1 syntax error",
    ])
  })

  it.each([
    ["an unterminated element", "export const T = () => <p>hello"],
    ["a stray `<` among the children", "export const V = () => <div><p>x</p><</div>"],
    ["an unclosed call before the markup closes", "export const W = () => <div><p>{foo(</p></div>"],
    ["an attribute whose quote never closes", 'export const X = () => <p title="a>x</p>'],
    ["a stray brace after an ampersand", "export const A = () => <div>a & } b</div>"],
    ["a stray angle bracket after an ampersand", "export const B = () => <div>a & > b</div>"],
    [
      "an unclosed call written below an ampersand",
      "export const C = () => (\n  <p>\n    a & b\n    {foo(}\n  </p>\n)",
    ],
  ])("reports %s", async (_label, source) => {
    expect(await parseErrorsOf(source, "src/a.tsx")).not.toEqual([])
  })

  it("keeps the delimiter rule out of an attribute's string, where all four are ordinary", async () => {
    expect(
      await parseErrorsOf('export const D = () => <a href="/x?a=1&b=2}">go</a>', "src/a.tsx"),
    ).toEqual([])
  })
})

/** The ids and kinds extraction produced, and the calls a walk of `id`'s body found. */
async function shapeOf(source: string, id: string, path: string) {
  return {
    symbols: (await symbolsOf(source, path)).map((s) => `${s.id} ${s.kind}`),
    calls: await callsOf(source, id, path),
  }
}

describe("the Symbols are the same with `&` as with `&amp;`", () => {
  const WITH_AMPERSAND = [
    "export function Card({ plan }: { plan: string }) {",
    "  const title = useTitle(plan)",
    "  return (",
    "    <section>",
    "      <h2>Subscription & Billing</h2>",
    "      <p>{format(title)}</p>",
    "    </section>",
    "  )",
    "}",
    "",
  ].join("\n")

  const ESCAPED = WITH_AMPERSAND.replace("Subscription & Billing", "Subscription &amp; Billing")

  it("extracts the same ids and the same calls, including one sited after the `&`", async () => {
    const card = "ts:src/card.tsx#Card"
    const withAmpersand = await shapeOf(WITH_AMPERSAND, card, "src/card.tsx")
    expect(withAmpersand.calls).toContain("format")
    expect(withAmpersand).toEqual(await shapeOf(ESCAPED, card, "src/card.tsx"))
  })
})

describe("where the lossless claim stops", () => {
  const BROKEN_WITH_AMPERSAND = "export const C = () => (\n  <p>\n    a & b\n    {foo(}\n  </p>\n)"
  const BROKEN_WITHOUT_AMPERSAND = BROKEN_WITH_AMPERSAND.replace("a & b", "a b")

  it("reports either way, and extracts the same ids", async () => {
    expect(await parseErrorsOf(BROKEN_WITH_AMPERSAND, "src/a.tsx")).not.toEqual([])
    expect((await shapeOf(BROKEN_WITH_AMPERSAND, "ts:src/a.tsx#C", "src/a.tsx")).symbols).toEqual(
      (await shapeOf(BROKEN_WITHOUT_AMPERSAND, "ts:src/a.tsx#C", "src/a.tsx")).symbols,
    )
  })

  it("loses the call written below the `&`, which the ampersand-free twin keeps", async () => {
    expect((await shapeOf(BROKEN_WITHOUT_AMPERSAND, "ts:src/a.tsx#C", "src/a.tsx")).calls).toEqual([
      "foo",
    ])
    expect((await shapeOf(BROKEN_WITH_AMPERSAND, "ts:src/a.tsx#C", "src/a.tsx")).calls).toEqual([])
  })
})
