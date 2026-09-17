/**
 * Both of the pipeline's budgets are read from the `Config` it is handed, and from nowhere
 * else — so a test cannot exercise a budget by a path the CLI does not use.
 */

import { noopRegistry, silentLogger } from "@aburi/test-support"
import type {
  BodyExtraction,
  CallCandidate,
  ClassifyContext,
  EffectPlugin,
  LanguagePlugin,
  OpaqueAstNode,
  ParseResult,
} from "@aburi/types"
import { describe, expect, it } from "vitest"
import { buildDropCFilter, DEFAULT_CLASSIFY_TIMEOUT_MS, runFilePipeline } from "../../src"
import { spend } from "../fixtures/clock"
import { effectsManifest, stubCandidate, stubFile, stubLanguagePlugin } from "../fixtures/plugins"

/** One Symbol with one call, so exactly one classify happens under exactly one budget. */
function stubLanguage(parseMs: number): LanguagePlugin {
  return stubLanguagePlugin({
    parseFile: async (): Promise<ParseResult> => {
      spend(parseMs)
      return { tree: {} as OpaqueAstNode, errors: [], imports: [] }
    },
    extractSymbols: () => [stubCandidate("one")],
    walkBody: (): BodyExtraction => ({
      rules: [],
      calls: [
        {
          target: "db.query",
          line: 2,
          argumentCount: 0,
          inAwait: false,
          inNew: false,
          literalArgs: [],
        },
      ],
    }),
  })
}

/** A classifier that spends `ms` before deciding nothing, so only the budget decides. */
function slowEffects(ms: number): EffectPlugin {
  return {
    manifest: effectsManifest(),
    init: async () => {},
    classify: (_call: CallCandidate, _ctx: ClassifyContext) => {
      spend(ms)
      return null
    },
  }
}

function run(config: { parseTimeoutMs?: number; classifyTimeoutMs?: number }, effectMs: number) {
  return runFilePipeline({
    file: stubFile,
    language: stubLanguage(0),
    frameworks: [],
    effects: [slowEffects(effectMs)],
    registry: noopRegistry,
    config,
    dropCFilter: buildDropCFilter(),
    component: null,
    treeReleaseFailures: [],
    log: silentLogger,
  })
}

describe("the classify budget comes from the config", () => {
  it("lets a classifier past the default run to completion when the config raised the budget", async () => {
    // The direction that cannot be faked: this classifier spends longer than the default, so
    // a pipeline reading anything but the config would record a timeout here.
    const slower = DEFAULT_CLASSIFY_TIMEOUT_MS + 30
    const result = await run({ classifyTimeoutMs: 5000 }, slower)

    expect(result.kind).toBe("extracted")
    if (result.kind !== "extracted") return
    expect(result.timeoutEvents).toEqual([])
  })

  it("reports the configured budget as the one that was blown", async () => {
    const result = await run({ classifyTimeoutMs: 10 }, 60)

    expect(result.kind).toBe("extracted")
    if (result.kind !== "extracted") return
    expect(result.timeoutEvents).toHaveLength(1)
    expect(result.timeoutEvents[0]?.budgetMs).toBe(10)
  })

  it("falls back to the documented default when the config names no budget", async () => {
    const result = await run({}, DEFAULT_CLASSIFY_TIMEOUT_MS + 30)

    expect(result.kind).toBe("extracted")
    if (result.kind !== "extracted") return
    expect(result.timeoutEvents).toHaveLength(1)
    expect(result.timeoutEvents[0]?.budgetMs).toBe(DEFAULT_CLASSIFY_TIMEOUT_MS)
  })
})

describe("the parse budget comes from the config", () => {
  it("abandons a file that overruns the budget the config named", async () => {
    const result = await runFilePipeline({
      file: stubFile,
      language: stubLanguage(250),
      frameworks: [],
      effects: [],
      registry: noopRegistry,
      config: { parseTimeoutMs: 100 },
      dropCFilter: buildDropCFilter(),
      component: null,
      treeReleaseFailures: [],
      log: silentLogger,
    })

    expect(result.kind).toBe("parse-timeout")
    if (result.kind !== "parse-timeout") return
    expect(result.timeout.budgetMs).toBe(100)
  })
})
