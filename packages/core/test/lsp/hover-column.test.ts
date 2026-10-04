import { describe, expect, it } from "vitest"
import { enrichWithLsp } from "../../src/lsp"
import { makeClassSymbol, makeEnrichmentInput, makeMethodSymbol } from "./fixtures/enrichment-ctx"
import { mockServerFactory } from "./fixtures/mock-server"

const HOVER_METHOD = "textDocument/hover"
const DOC_SYMBOL_METHOD = "textDocument/documentSymbol"

/**
 * Where on the line the pass hovers for a `this.<method>` call. It has only the line's text to
 * go on, and an earlier token the needle is a prefix of, or the needle inside a string or a
 * comment, drew the hover to a different member — whose owner then became the call's target.
 */
async function hoveredColumns(callLine: string, target: string): Promise<number[]> {
  const cls = makeClassSymbol("src/a.ts", "C", 1)
  const caller = makeMethodSymbol("src/a.ts", "C", "run", 2, [{ target, line: 3 }])
  const seen: number[] = []
  const factory = mockServerFactory((_lang, client) => {
    client.installHandler(DOC_SYMBOL_METHOD, () => [])
    client.installHandler(HOVER_METHOD, (params) => {
      seen.push((params as { position: { character: number } }).position.character)
      return null
    })
  })
  await enrichWithLsp(
    makeEnrichmentInput({
      symbols: [cls, caller],
      fileContents: { "src/a.ts": `class C {\n  run() {\n${callLine}\n  }\n}` },
      serverFactory: factory,
    }),
  )
  return seen
}

describe("the hover lands on the call's own method", () => {
  it.each([
    [
      "a longer member before it",
      "    this.saveAll(); return this.save()",
      "this.save",
      "return this.save",
    ],
    [
      "a property it prefixes",
      "    this.handlers.forEach(() => this.handle())",
      "this.handle",
      "=> this.handle",
    ],
    [
      "another receiver ending in the head",
      "    mythis.foo(); this.foo()",
      "this.foo",
      "; this.foo",
    ],
    ["the needle in a string", '    log("this.save"); this.save()', "this.save", "; this.save"],
    [
      "the needle in a template literal's text",
      "    log(`this.save`); this.save()",
      "this.save",
      "; this.save",
    ],
    [
      "the needle in a string, to a call in a template literal's interpolation",
      `    return "this.save=" + \`\${this.save()}\``,
      "this.save",
      "{this.save",
    ],
    [
      "the needle in a block comment",
      "    /* this.save */ this.save()",
      "this.save",
      "*/ this.save",
    ],
  ])("past %s", async (_label, line, target, anchor) => {
    const offset = anchor.indexOf(target)
    const expected = line.indexOf(anchor) + offset + target.indexOf(".") + 1

    expect(await hoveredColumns(line, target)).toEqual([expected])
  })

  it.each([
    ["a call alone on its line", "    return this.save()", "this.save"],
    [
      "a call in a template literal's interpolation",
      `    return \`n=\${this.save()}\``,
      "this.save",
    ],
    [
      "a call past an apostrophe in JSX text",
      "    return <p>Don't {this.title()}</p>",
      "this.title",
    ],
  ])("still finds %s", async (_label, line, target) => {
    expect(await hoveredColumns(line, target)).toEqual([
      line.indexOf(target) + target.indexOf(".") + 1,
    ])
  })
})
