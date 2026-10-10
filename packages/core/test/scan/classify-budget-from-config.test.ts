import { makeCall } from "@aburi/test-support"
import type { Config } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { DEFAULT_CLASSIFY_TIMEOUT_MS } from "../../src"
import { spend } from "../fixtures/clock"
import {
  expectExtracted,
  runPipeline,
  ScriptedLanguagePlugin,
  stubEffectsPlugin,
} from "../fixtures/plugins"

/** One Symbol with one call, classified by a plugin that spends `effectMs` and decides nothing. */
function run(config: Config, effectMs: number) {
  return runPipeline({
    language: new ScriptedLanguagePlugin({
      body: { rules: [], calls: [makeCall({ target: "db.query", line: 2 })] },
    }),
    effects: [
      stubEffectsPlugin("effects-stub", () => {
        spend(effectMs)
        return null
      }),
    ],
    config,
  })
}

describe("the classify budget comes from the config", () => {
  it("lets a classifier past the default run to completion when the config raised the budget", async () => {
    const { timeoutEvents } = expectExtracted(
      await run({ classifyTimeoutMs: 5000 }, DEFAULT_CLASSIFY_TIMEOUT_MS + 30),
    )
    expect(timeoutEvents).toEqual([])
  })

  it.each<[string, Config, number]>([
    ["the configured budget", { classifyTimeoutMs: 10 }, 10],
    ["the default budget when the config names none", {}, DEFAULT_CLASSIFY_TIMEOUT_MS],
  ])("reports %s as the one that was blown", async (_label, config, budgetMs) => {
    const { timeoutEvents } = expectExtracted(await run(config, budgetMs + 30))
    expect(timeoutEvents.map((event) => event.budgetMs)).toEqual([budgetMs])
  })
})
