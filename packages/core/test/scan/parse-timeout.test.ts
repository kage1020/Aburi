import type { ParseError } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { DEFAULT_PARSE_TIMEOUT_MS, PARSE_TIMEOUT_MIN_MS, startParseDeadline } from "../../src"
import { runPipeline, type Script, ScriptedLanguagePlugin } from "../fixtures/plugins"

async function run(script: Script, parseTimeoutMs: number) {
  const plugin = new ScriptedLanguagePlugin(script)
  const result = await runPipeline({ language: plugin, config: { parseTimeoutMs } })
  return { result, order: plugin.order }
}

const RECOVERABLE: ParseError = {
  message: "unexpected token",
  line: 1,
  column: 1,
  recoverable: true,
}

describe("startParseDeadline", () => {
  it.each<[string, number | undefined, number]>([
    ["no budget as the default", undefined, DEFAULT_PARSE_TIMEOUT_MS],
    ["a budget below the minimum as the minimum", 1, PARSE_TIMEOUT_MIN_MS],
    ["a budget above the minimum as written", 250, 250],
  ])("takes %s", (_label, configured, budget) => {
    expect(startParseDeadline(configured).budgetMs).toBe(budget)
  })
})

describe("runFilePipeline — parse deadline", () => {
  it.each<[string, Script, string[]]>([
    ["its parse alone overran, without extracting it", { parseMs: 250 }, ["releaseTree"]],
    [
      "its extraction overran, before walking anything",
      { extractMs: 250 },
      ["extractSymbols", "releaseTree"],
    ],
    [
      "a walk overran, before the next candidate",
      { candidates: ["one", "two"], walkMsPerCandidate: 150 },
      ["extractSymbols", "walkBody:one", "normalizeAst:one", "releaseTree"],
    ],
  ])("abandons a file once %s, and releases its tree", async (_label, script, order) => {
    const { result, order: called } = await run(script, 100)
    expect(result.kind).toBe("parse-timeout")
    expect(called).toEqual(order)
  })

  it("hands back only the file, its parse errors and what the budget measured", async () => {
    const { result } = await run(
      {
        parseMs: 250,
        parseErrors: [RECOVERABLE],
        imports: [{ source: "./other", symbols: ["thing"], line: 1, dynamic: false }],
      },
      100,
    )
    expect(result).toEqual({
      kind: "parse-timeout",
      path: "test.stub",
      parseErrors: [RECOVERABLE],
      timeout: { file: "test.stub", budgetMs: 100, elapsedMs: expect.any(Number) },
    })
    expect(result.kind === "parse-timeout" && result.timeout.elapsedMs).toBeGreaterThanOrEqual(100)
  })

  it.each<[string, Script]>([
    ["no tree", { parseMs: 250, tree: null }],
    [
      "a non-recoverable error",
      { parseMs: 250, parseErrors: [{ ...RECOVERABLE, recoverable: false }] },
    ],
  ])("reports a file with %s as a parse failure even when its parse overran", async (_label, script) => {
    const { result } = await run(script, 100)
    expect(result.kind).toBe("parse-failed")
  })

  it("leaves a file that finishes inside its budget untouched", async () => {
    const { result, order } = await run({ candidates: ["one", "two"] }, 600_000)
    expect(result.kind === "extracted" && result.symbols.map((s) => s.name)).toEqual(["one", "two"])
    expect(order.filter((call) => call.startsWith("walkBody"))).toEqual([
      "walkBody:one",
      "walkBody:two",
    ])
  })
})
