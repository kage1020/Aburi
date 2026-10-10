import { makeCall, rule, symbolId } from "@aburi/test-support"
import type { Symbol as IRSymbol } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { CoreError, ZERO_FINGERPRINT } from "../../src"
import {
  extractOneSymbol,
  type OneSymbolFile,
  stubCandidate,
  stubEffectsPlugin,
} from "../fixtures/plugins"

const emitting = stubEffectsPlugin("effects-loud", (call) => ({
  effectId: "event.publish",
  confidence: "high",
  derivedBy: `effects-loud:${call.target}`,
}))

describe("runFilePipeline — list fields leave in line order", () => {
  it.each<[string, OneSymbolFile, (symbol: IRSymbol) => unknown[], unknown[]]>([
    [
      "calls[]",
      {
        body: {
          rules: [],
          calls: [
            makeCall({ target: "zeta.doWork", line: 20 }),
            makeCall({ target: "alpha.doWork", line: 40 }),
            makeCall({ target: "mid.doWork", line: 10 }),
          ],
        },
      },
      (symbol) => symbol.calls.map((c) => c.target),
      ["mid.doWork", "zeta.doWork", "alpha.doWork"],
    ],
    [
      "effects[]",
      {
        effects: [emitting],
        body: {
          rules: [],
          calls: [
            makeCall({ target: "zeta.emit", line: 15 }),
            makeCall({ target: "alpha.emit", line: 60 }),
          ],
        },
      },
      (symbol) => symbol.effects.map((e) => e.target),
      ["zeta.emit", "alpha.emit"],
    ],
    [
      "decorators[]",
      {
        candidate: stubCandidate("Fn", {
          decorators: [
            { name: "Later", raw: "@Later()", arguments: [], boundary: false, line: 30 },
            { name: "Earlier", raw: "@Earlier()", arguments: [], boundary: false, line: 5 },
          ],
        }),
      },
      (symbol) => symbol.decorators.map((d) => d.name),
      ["Earlier", "Later"],
    ],
    [
      "rules[]",
      {
        body: {
          rules: [
            rule({ type: "throw", line: 9, what: "Error" }),
            rule({ type: "guard", line: 3 }),
          ],
          calls: [],
        },
      },
      (symbol) => symbol.rules.map((r) => r.line),
      [3, 9],
    ],
  ])("orders %s by line, whatever order the plugin produced it in", async (_field, file, read, expected) => {
    const { symbols } = await extractOneSymbol(file)
    expect(read(symbols[0] as IRSymbol)).toEqual(expected)
  })

  it("orders calls on one line by target, not by where the source wrote them", async () => {
    const { symbols } = await extractOneSymbol({
      body: {
        rules: [],
        calls: [
          makeCall({ target: "third.hit", line: 10 }),
          makeCall({ target: "first.hit", line: 10 }),
          makeCall({ target: "second.hit", line: 10 }),
        ],
      },
    })
    expect(symbols[0]?.calls.map((c) => c.target)).toEqual(["first.hit", "second.hit", "third.hit"])
  })
})

describe("runFilePipeline — the Symbol record", () => {
  it("writes a plugin's long, multi-line rule strings in their normalized, truncated form", async () => {
    const { symbols } = await extractOneSymbol({
      body: {
        rules: [
          rule({ type: "guard", line: 3, condition: `a ||\n    ${"x".repeat(200)}` }),
          rule({ type: "throw", line: 4, what: "make({\n  code })" }),
        ],
        calls: [],
      },
    })
    expect(symbols[0]?.rules.map((r) => [r.condition, r.what])).toEqual([
      [`a || ${"x".repeat(115)}...`, null],
      [null, "make({ code })"],
    ])
  })

  it("refuses a Symbol id that carries no language prefix", async () => {
    const candidate = { ...stubCandidate("Fn"), id: symbolId("no-colon-here") }
    const outcome = extractOneSymbol({ candidate })
    await expect(outcome).rejects.toBeInstanceOf(CoreError)
    await expect(outcome).rejects.toMatchObject({ code: "scan-plugin-misconfigured" })
  })

  it("records a dropped Symbol without walking its body, and with a zero fingerprint", async () => {
    const walked: string[] = []
    const { symbols } = await extractOneSymbol({
      candidate: stubCandidate("Shape", { kind: "interface" }),
      language: {
        walkBody: (symbol) => {
          walked.push(symbol.name)
          return { rules: [rule({ type: "guard" })], calls: [makeCall({ target: "x.y" })] }
        },
      },
    })

    expect(walked).toEqual([])
    expect(symbols[0]).toMatchObject({
      dropped: true,
      rules: [],
      effects: [],
      calls: [],
      fingerprint: { api: ZERO_FINGERPRINT, logic: ZERO_FINGERPRINT, syntax: ZERO_FINGERPRINT },
    })
  })

  it("fingerprints a kept Symbol's syntax from the AST the language plugin normalized", async () => {
    const [first, second] = await Promise.all(
      ["one-ast", "another-ast"].map((normalized) =>
        extractOneSymbol({ language: { normalizeAst: () => normalized } }),
      ),
    )
    const a = first?.symbols[0]?.fingerprint
    const b = second?.symbols[0]?.fingerprint
    expect(a?.syntax).not.toBe(b?.syntax)
    expect(a?.syntax).not.toBe(ZERO_FINGERPRINT)
    expect(a?.api).toBe(b?.api)
  })
})
