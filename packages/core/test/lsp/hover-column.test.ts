import { describe, expect, it } from "vitest"
import { resolveCallGraph } from "../../src/callgraph"
import { enrichWithLsp } from "../../src/lsp"
import { makeClassSymbol, makeEnrichmentInput, makeMethodSymbol } from "./fixtures/enrichment-ctx"
import { mockServerFactory } from "./fixtures/mock-server"

const HOVER_METHOD = "textDocument/hover"
const DOC_SYMBOL_METHOD = "textDocument/documentSymbol"

type HoverPosition = { line: number; character: number }

/** 0-based line of `callLine` in the fixture `hoveredPositions` builds. */
const CALL_LINE = 2

async function hoveredPositions(callLine: string, ...targets: string[]): Promise<HoverPosition[]> {
  const cls = makeClassSymbol("src/a.ts", "C", 1)
  const calls = targets.map((target) => ({ target, line: CALL_LINE + 1 }))
  const caller = makeMethodSymbol("src/a.ts", "C", "run", 2, calls)
  const seen: HoverPosition[] = []
  const factory = mockServerFactory((_lang, client) => {
    client.installHandler(DOC_SYMBOL_METHOD, () => [])
    client.installHandler(HOVER_METHOD, (params) => {
      const { line, character } = (params as { position: HoverPosition }).position
      seen.push({ line, character })
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

function expectedColumn(line: string, anchor: string, target: string): number {
  const at = line.indexOf(anchor)
  if (at === -1 || at !== line.lastIndexOf(anchor)) {
    throw new Error(`anchor ${JSON.stringify(anchor)} must occur once in ${JSON.stringify(line)}`)
  }
  return at + anchor.lastIndexOf(target.slice(target.indexOf(".") + 1))
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
      "a longer member spelled in letters outside ASCII",
      "    this.保存する(); this.保存()",
      "this.保存",
      "; this.保存",
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
    [
      "another receiver ending in the head after a letter outside ASCII",
      "    éthis.save(); this.save()",
      "this.save",
      "; this.save",
    ],
    [
      "a property named like the head",
      "    ctx.this.save(); this.save()",
      "this.save",
      "; this.save",
    ],
    [
      "a longer member, on `super`",
      "    super.saveAll(); super.save()",
      "super.save",
      "; super.save",
    ],
    [
      "a longer member whose name opens with `$`",
      "    this.$emitAll(); this.$emit('x')",
      "this.$emit",
      "; this.$emit",
    ],
    ["a longer private member", "    this.#saveAll(); this.#save()", "this.#save", "; this.#save"],
    ["the needle in a string", '    log("this.save"); this.save()', "this.save", "; this.save"],
    [
      "the needle in a string after an escaped quote",
      '    log("\\"this.save"); this.save()',
      "this.save",
      "; this.save",
    ],
    [
      "the needle in a template literal's text",
      "    log(`this.save`); this.save()",
      "this.save",
      "; this.save",
    ],
    [
      "the needle after an escaped `\\${` in a template literal's text",
      `    log(\`\\\${this.save}\`); this.save()`,
      "this.save",
      "; this.save",
    ],
    [
      "the needle in a nested template literal's text, to a call in its interpolation",
      `    log(\`a\${\`this.save \${this.save()}\`}\`)`,
      "this.save",
      "{this.save",
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
    [
      "a longer member, on a line whose apostrophe in JSX text hides both",
      "    return <p>Don't {this.saveAll()} {this.save()}</p>",
      "this.save",
      "} {this.save",
    ],
  ])("past %s", async (_label, line, target, anchor) => {
    expect(await hoveredPositions(line, target)).toEqual([
      { line: CALL_LINE, character: expectedColumn(line, anchor, target) },
    ])
  })

  it.each([
    ["a call alone on its line", "    return this.save()", "this.save", "this.save"],
    [
      "a call in a template literal's interpolation",
      `    return \`n=\${this.save()}\``,
      "this.save",
      "this.save",
    ],
    [
      "a call past an apostrophe in JSX text",
      "    return <p>Don't {this.title()}</p>",
      "this.title",
      "this.title",
    ],
    ["an optional call", "    return this?.save()", "this.save", "this?.save"],
    ["a call in a spread", "    return [...this.items()]", "this.items", "this.items"],
    ["a call right after `??`", "    return cached??this.load()", "this.load", "this.load"],
  ])("still finds %s", async (_label, line, target, anchor) => {
    expect(await hoveredPositions(line, target)).toEqual([
      { line: CALL_LINE, character: expectedColumn(line, anchor, target) },
    ])
  })

  it.each([
    ["a computed member", '    this["save"]()', "this.save"],
    [
      "a line whose only occurrence is a longer member",
      "    return <p>Don't {this.saveAll()}</p>",
      "this.save",
    ],
    [
      "a line the mask misread, where the needle is also in a string",
      `    return <p>Don't {log("this.save")} {this.save()}</p>`,
      "this.save",
    ],
    [
      "a line the mask misread, where the call is written twice",
      "    return <p>Don't {this.save()} {this.save()}</p>",
      "this.save",
    ],
  ])("does not hover %s", async (_label, line, target) => {
    expect(await hoveredPositions(line, target)).toEqual([])
  })

  it("hovers the first of two calls to one target on a line, for both", async () => {
    const line = "    this.save(); this.save()"
    const first = { line: CALL_LINE, character: expectedColumn(line, "    this.save", "this.save") }

    expect(await hoveredPositions(line, "this.save", "this.save")).toEqual([first, first])
  })

  it("reads a regex literal as code, so an occurrence inside one draws the hover", async () => {
    const line = "    if (/this.save/.test(s)) this.save()"

    expect(await hoveredPositions(line, "this.save")).toEqual([
      { line: CALL_LINE, character: expectedColumn(line, "/this.save", "this.save") },
    ])
  })
})

describe("the hint names the call's own method", () => {
  it("resolves an override's call to the override, not to the base member a longer name reaches", async () => {
    const callLine = "    this.saveAll(); return this.save()"
    const lines = [
      "class BaseStore {",
      "  save() {}",
      "  saveAll() {}",
      "}",
      "class UserStore extends BaseStore {",
      "  save() {}",
      "  run() {",
      callLine,
      "  }",
      "}",
    ]
    const callIndex = lines.indexOf(callLine)
    const run = makeMethodSymbol("src/a.ts", "UserStore", "run", callIndex, [
      { target: "this.saveAll", line: callIndex + 1 },
      { target: "this.save", line: callIndex + 1 },
    ])
    const symbols = [
      makeClassSymbol("src/a.ts", "BaseStore", 1),
      makeMethodSymbol("src/a.ts", "BaseStore", "save", 2),
      makeMethodSymbol("src/a.ts", "BaseStore", "saveAll", 3),
      makeClassSymbol("src/a.ts", "UserStore", 5),
      makeMethodSymbol("src/a.ts", "UserStore", "save", 6),
      run,
    ]
    const at = (anchor: string, target: string) =>
      `${callIndex}:${expectedColumn(callLine, anchor, target)}`
    const answers = new Map([
      [at("    this.saveAll", "this.saveAll"), "BaseStore.saveAll"],
      [at("return this.save", "this.save"), "UserStore.save"],
    ])
    const factory = mockServerFactory((_lang, client) => {
      client.installHandler(DOC_SYMBOL_METHOD, () => [])
      client.installHandler(HOVER_METHOD, (params) => {
        const { line, character } = (params as { position: HoverPosition }).position
        const member = answers.get(`${line}:${character}`)
        return member === undefined ? null : { contents: `(method) ${member}(): void` }
      })
    })
    const enrichment = await enrichWithLsp(
      makeEnrichmentInput({
        symbols,
        fileContents: { "src/a.ts": lines.join("\n") },
        serverFactory: factory,
      }),
    )
    const result = resolveCallGraph({
      symbols: enrichment.symbols,
      importsByFile: new Map(),
      receiverHints: enrichment.receiverHints,
      implementerHints: enrichment.implementerHints,
    })

    const resolved = result.symbols.find((s) => s.id === run.id)?.calls.map((c) => c.resolved)
    expect(resolved).toEqual(["ts:src/a.ts#BaseStore.saveAll", "ts:src/a.ts#UserStore.save"])
  })
})
