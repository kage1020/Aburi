/**
 * Both of the pipeline's budgets are read from the `Config` it is handed, and from nowhere
 * else — so a test cannot exercise a budget by a path the CLI does not use.
 */

import { noopRegistry, silentLogger } from "@aburi/test-support"
import type {
  BodyExtraction,
  CallCandidate,
  ClassifyContext,
  EffectClassification,
  EffectPlugin,
  LanguagePlugin,
  OpaqueAstNode,
  ParseResult,
} from "@aburi/types"
import { describe, expect, it } from "vitest"
import {
  buildDropCFilter,
  DEFAULT_CLASSIFY_TIMEOUT_MS,
  runFilePipeline,
  VocabCheck,
} from "../../src"
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
    vocab: new VocabCheck(noopRegistry, true),
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

/** An effects plugin under its own name that answers `answer` after spending `ms`. */
function answeringEffects(
  name: string,
  ms: number,
  answer: EffectClassification | null,
  seen: string[] = [],
): EffectPlugin {
  const manifest = effectsManifest(name)
  return {
    manifest: {
      ...manifest,
      provides: { ...manifest.provides, derivedByPrefixes: ["effects-plugin:stub"] },
    },
    init: async () => {},
    classify: (call: CallCandidate) => {
      seen.push(call.target)
      spend(ms)
      return answer
    },
  }
}

function runWith(effects: EffectPlugin[]) {
  return runFilePipeline({
    file: stubFile,
    language: stubLanguage(0),
    frameworks: [],
    effects,
    registry: noopRegistry,
    vocab: new VocabCheck(noopRegistry, true),
    config: { classifyTimeoutMs: 10 },
    dropCFilter: buildDropCFilter(),
    component: null,
    treeReleaseFailures: [],
    log: silentLogger,
  })
}

const READ: EffectClassification = {
  effectId: "db.read",
  confidence: "high",
  derivedBy: "effects-plugin:stub:read",
}

describe("a classification that overruns the budget (EP13)", () => {
  it("is kept, the overrun recorded beside it, and the next plugin never asked", async () => {
    // Dropping it saved nothing, since the work was done, and made the IR depend on how busy
    // the machine was: the same source gave a Symbol with or without its effect.
    const asked: string[] = []
    const result = await runWith([
      answeringEffects("effects-slow", 30, READ),
      answeringEffects("effects-next", 0, { ...READ, effectId: "db.write" }, asked),
    ])

    expect(result.kind).toBe("extracted")
    if (result.kind !== "extracted") return
    expect(result.timeoutEvents.map((event) => event.plugin)).toEqual(["effects-slow"])
    expect(
      result.symbols[0]?.effects.map((effect) => [effect.id, effect.target, effect.plugin]),
    ).toEqual([["db.read", "db.query", "effects-slow"]])
    expect(result.symbols[0]?.calls).toEqual([])
    expect(asked).toEqual([])
  })

  it("hands the call on when the slow answer was null, as a fast null would", async () => {
    const result = await runWith([
      answeringEffects("effects-slow", 30, null),
      answeringEffects("effects-next", 0, READ),
    ])

    expect(result.kind).toBe("extracted")
    if (result.kind !== "extracted") return
    expect(result.timeoutEvents.map((event) => event.plugin)).toEqual(["effects-slow"])
    expect(result.symbols[0]?.effects.map((effect) => [effect.id, effect.plugin])).toEqual([
      ["db.read", "effects-next"],
    ])
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
      vocab: new VocabCheck(noopRegistry, true),
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
