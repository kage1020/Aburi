import type { WalkContext } from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { Node } from "web-tree-sitter"
import { walkBody } from "../src/index"
import { makeExtractionCtx, parseSource, symbolsOf } from "./fixtures/ctx"

/**
 * The tsx grammar reads `&` inside JSX as the opening of an HTML character reference and errors
 * when no `;` closes it, so `Subscription & Billing` and `?utm_source=a&utm_medium=b` — prose and
 * a tracking URL — are parse errors. No published grammar has fixed it as of 2026-09, and the
 * dependency is a `^0.3.1` range, so a fix would arrive on its own if one ever shipped.
 *
 * `collectParseErrors` drops exactly that shape (`lang-plugin.md` LP27a). These suites hold the
 * two halves of why that is safe: the shape is narrow enough that a broken file still reports,
 * and dropping it loses nothing, because the Symbols come out the same either way.
 */

async function errorsOf(path: string, content: string): Promise<string[]> {
  const result = await parseSource(content, path)
  return result.errors.map((e) => `${e.line}:${e.column} ${e.message}`)
}

describe("the grammar's `&` in JSX is not reported as a parse error", () => {
  it.each([
    ["bare, between words", "export const A = () => <p>a & b</p>"],
    ["at the end of the text", "export const G = () => <p>a &</p>"],
    ["doubled", "export const H = () => <p>a && b</p>"],
    ["followed by an assignment", "export const I = () => <p>a &= b</p>"],
    // Load-bearing for the fragment half of the claim, and it holds for a reason worth
    // naming: the grammar has no `jsx_fragment` node, so `<>…</>` parses as a `jsx_element`
    // whose opening tag is empty. The position rule reaches it without a second branch.
    ["in a fragment", "export const J = () => <>a & b</>"],
    [
      "nested one element down",
      "export const K = () => <div><span>Subscription & Billing</span></div>",
    ],
    ["entity-shaped inside an attribute", 'export const D = () => <p title="a&b">x</p>'],
    ["a query string inside an attribute", 'export const E = () => <a href="/x?a=1&b=2">go</a>'],
    // A self-closing element reaches the attribute rule by the same path: the ERROR is still
    // parented by `string` under `jsx_attribute`, so the element's form never enters it.
    ["inside a self-closing element's attribute", 'export const P = () => <img alt="a&b" />'],
  ])("%s", async (_label, source) => {
    expect(await errorsOf("src/a.tsx", source)).toEqual([])
  })

  it("is silent on `.jsx` too, which routes to the same grammar", async () => {
    expect(await errorsOf("src/a.jsx", "export const A = () => <p>a & b</p>")).toEqual([])
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
    // The suite above would pass if `collectParseErrors` had simply stopped reporting ERRORs in
    // JSX. These rows are the ones the grammar already accepted, so they say the change is a
    // narrowing of what is reported rather than of what is parsed.
    expect(await errorsOf(path, source)).toEqual([])
  })
})

describe("a file that really is broken still reports", () => {
  it("reports a truncation that carries an ampersand of its own", async () => {
    // Both ERRORs are in this tree: the `& b` inside the `<p>`, and the unterminated `<div>` at
    // `program`. Dropping the first must not take the second with it, which is the whole risk
    // the narrow shape is there to avoid.
    expect(await errorsOf("src/a.tsx", "export const U = () => <div><p>a & b</p>")).toEqual([
      "1:1 syntax error",
    ])
  })

  it.each([
    ["an unterminated element", "export const T = () => <p>hello"],
    ["a stray `<` among the children", "export const V = () => <div><p>x</p><</div>"],
    ["an unclosed call before the markup closes", "export const W = () => <div><p>{foo(</p></div>"],
    ["an attribute whose quote never closes", 'export const X = () => <p title="a>x</p>'],
  ])("reports %s", async (_label, source) => {
    expect(await errorsOf("src/a.tsx", source)).not.toEqual([])
  })

  // The rows above all break the file where the ampersand's own ERROR cannot reach. These break
  // it *inside* the run: tree-sitter merges an adjacent unparseable stretch into one ERROR node,
  // so a filter that read only its first token let an `&` earlier in the same JSX children
  // swallow everything after it. Each of these was silent before the delimiter rule.
  it.each([
    ["a stray brace after an ampersand", "export const A = () => <div>a & } b</div>"],
    ["a stray angle bracket after an ampersand", "export const B = () => <div>a & > b</div>"],
    [
      "an unclosed call written below an ampersand",
      "export const C = () => (\n  <p>\n    a & b\n    {foo(}\n  </p>\n)",
    ],
  ])("reports %s", async (_label, source) => {
    expect(await errorsOf("src/a.tsx", source)).not.toEqual([])
  })

  it("keeps the delimiter rule out of an attribute's string, where all four are ordinary", async () => {
    // A string literal is not JSX text. `}` in a URL is legal and common, and applying the rule
    // here would have the warning over-report the very thing it exists to stop over-reporting.
    expect(
      await errorsOf("src/a.tsx", 'export const D = () => <a href="/x?a=1&b=2}">go</a>'),
    ).toEqual([])
  })
})

/** The ids extraction produced, and the calls a walk of `name`'s body found. */
async function shapeOf(
  source: string,
  name: string,
  path: string,
): Promise<{ symbols: string[]; calls: string[] }> {
  const symbols = await symbolsOf(source, path)
  const target = symbols.find((s) => s.name === name)
  if (target === undefined) throw new Error(`no Symbol ${name} in fixture`)
  const walkCtx: WalkContext<Node> = { ...makeExtractionCtx(path, source), symbol: target }
  return {
    symbols: symbols.map((s) => `${s.id} ${s.kind}`),
    calls: walkBody(target, walkCtx).calls.map((c) => c.target),
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
    // What makes the drop lossless rather than convenient: recovery already salvages the whole
    // declaration, so the reported error was never standing for missing data. `format` is
    // written below the ampersand and survives it.
    const withAmpersand = await shapeOf(WITH_AMPERSAND, "Card", "src/card.tsx")
    expect(withAmpersand.calls).toContain("format")
    expect(withAmpersand).toEqual(await shapeOf(ESCAPED, "Card", "src/card.tsx"))
  })
})

describe("where the lossless claim stops", () => {
  // The suite above reads a file the grammar recovers cleanly, and there the ampersand costs
  // nothing. This is the same measurement on the file that is genuinely broken underneath it,
  // and it comes out the other way: when the ampersand's run merges with a real break,
  // `walkBody` loses the call that sits in the merged stretch.
  //
  // Both are worth having on the page, because together they say what the delimiter rule did
  // and did not buy. It restored the diagnostic — this file is silent without it — but the
  // call edge does not come back with it. Nothing in this package recovers that edge today.
  const BROKEN_WITH_AMPERSAND = "export const C = () => (\n  <p>\n    a & b\n    {foo(}\n  </p>\n)"
  const BROKEN_WITHOUT_AMPERSAND = BROKEN_WITH_AMPERSAND.replace("a & b", "a b")

  it("reports either way, and extracts the same ids", async () => {
    expect(await errorsOf("src/a.tsx", BROKEN_WITH_AMPERSAND)).not.toEqual([])
    expect((await shapeOf(BROKEN_WITH_AMPERSAND, "C", "src/a.tsx")).symbols).toEqual(
      (await shapeOf(BROKEN_WITHOUT_AMPERSAND, "C", "src/a.tsx")).symbols,
    )
  })

  it("loses the call written below the `&`, which the ampersand-free twin keeps", async () => {
    expect((await shapeOf(BROKEN_WITHOUT_AMPERSAND, "C", "src/a.tsx")).calls).toEqual(["foo"])
    expect((await shapeOf(BROKEN_WITH_AMPERSAND, "C", "src/a.tsx")).calls).toEqual([])
  })
})
