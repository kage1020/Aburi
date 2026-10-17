import { makeCall, spend } from "@aburi/test-support"
import type { CallCandidate, ClassifyContext, Decorator, EffectClassification } from "@aburi/types"
import { describe, expect, it } from "vitest"
import { makeCallSiteKey } from "../../src/call-site"
import {
  extractOneSymbol,
  stubCandidate,
  stubEffectsPlugin,
  stubFrameworkPlugin,
} from "../fixtures/plugins"

function bodyCalling(...calls: CallCandidate[]) {
  return { rules: [], calls }
}

const QUALIFIED_POST: Decorator = {
  name: "Post",
  qualifier: "tsed",
  raw: "@tsed.Post()",
  arguments: [],
  boundary: false,
  line: 1,
}

describe("runFilePipeline — effect classification", () => {
  it("records the first effect plugin's classification and asks no later one", async () => {
    const asked: string[] = []
    const first = stubEffectsPlugin("effects-first", (call) => ({
      effectId: "db.read",
      confidence: "medium",
      derivedBy: `effects-first:${call.target}`,
    }))
    const second = stubEffectsPlugin("effects-second", (call) => {
      asked.push(call.target)
      return null
    })

    const { symbols } = await extractOneSymbol({
      effects: [first, second],
      body: bodyCalling(makeCall({ target: "prisma.user.findMany", line: 4 })),
    })

    expect(symbols[0]?.effects).toEqual([
      {
        id: "db.read",
        target: "prisma.user.findMany",
        line: 4,
        plugin: "effects-first",
        confidence: "medium",
        derivedBy: "effects-first:prisma.user.findMany",
      },
    ])
    expect(symbols[0]?.calls).toEqual([])
    expect(asked).toEqual([])
  })

  it("falls through an effect plugin that classifies nothing to the next", async () => {
    const { symbols } = await extractOneSymbol({
      effects: [
        stubEffectsPlugin("effects-first", () => null),
        stubEffectsPlugin("effects-second", () => ({
          effectId: "db.write",
          confidence: "high",
          derivedBy: "effects-second:hit",
        })),
      ],
      body: bodyCalling(makeCall({ target: "something.update" })),
    })

    expect(symbols[0]?.effects.map((e) => [e.plugin, e.id])).toEqual([
      ["effects-second", "db.write"],
    ])
  })

  it("leaves a call nobody classified in calls[], unresolved", async () => {
    const { symbols } = await extractOneSymbol({
      effects: [stubEffectsPlugin("effects-none", () => null)],
      body: bodyCalling(makeCall({ target: "helper.doWork" })),
    })
    expect(symbols[0]?.calls).toEqual([{ target: "helper.doWork", line: 1, resolved: null }])
  })

  it("drops a Category C call before any effect plugin sees it", async () => {
    const asked: string[] = []
    const { symbols } = await extractOneSymbol({
      effects: [
        stubEffectsPlugin("effects-watch", (call) => {
          asked.push(call.target)
          return null
        }),
      ],
      body: bodyCalling(makeCall({ target: "console.log" }), makeCall({ target: "helper.doWork" })),
    })

    expect(asked).toEqual(["helper.doWork"])
    expect(symbols[0]?.calls.map((c) => c.target)).toEqual(["helper.doWork"])
  })

  it("keys only an unclassified call whose receiver is an expression as a dynamic call site", async () => {
    const result = await extractOneSymbol({
      effects: [
        stubEffectsPlugin("effects-db", (call) =>
          call.target === "db().save"
            ? { effectId: "db.write", confidence: "high", derivedBy: "effects-db:hit" }
            : null,
        ),
      ],
      body: bodyCalling(
        makeCall({ target: "make().run", line: 3, dynamicReceiver: true }),
        makeCall({ target: "db().save", line: 4, dynamicReceiver: true }),
        makeCall({ target: "helper.run", line: 5 }),
      ),
    })

    expect(result.dynamicCallSites).toEqual([makeCallSiteKey("test.stub", 3, "make().run")])
  })

  it("hands the effect plugin each owner decorator's receiver, and none for a bare one", async () => {
    const seen: ClassifyContext["owner"]["decorators"][] = []
    const candidate = stubCandidate("Fn", {
      decorators: [
        QUALIFIED_POST,
        { name: "Get", raw: "@Get()", arguments: [], boundary: false, line: 2 },
      ],
    })

    await extractOneSymbol({
      candidate,
      effects: [
        stubEffectsPlugin("effects-owner", (_call, ctx) => {
          seen.push(ctx.owner.decorators)
          return null
        }),
      ],
      body: bodyCalling(makeCall({ target: "db.save" })),
    })

    expect(seen).toStrictEqual([
      [
        { name: "Post", qualifier: "tsed", boundary: false },
        { name: "Get", boundary: false },
      ],
    ])
  })

  it("hands the effect plugin a boundary a framework plugin keyed on the qualified decorator", async () => {
    const seen: ClassifyContext["owner"]["decorators"][] = []
    const framework = stubFrameworkPlugin("framework-qualified", {
      classifySymbol: () => ({
        extKind: "framework:tsed:route",
        decoratorBoundaries: { "tsed.Post": true },
        derivedBy: "framework-qualified:hit",
      }),
    })

    await extractOneSymbol({
      candidate: stubCandidate("Fn", { decorators: [QUALIFIED_POST] }),
      frameworks: [framework],
      effects: [
        stubEffectsPlugin("effects-owner", (_call, ctx) => {
          seen.push(ctx.owner.decorators)
          return null
        }),
      ],
      body: bodyCalling(makeCall({ target: "db.save" })),
    })

    expect(seen).toStrictEqual([[{ name: "Post", qualifier: "tsed", boundary: true }]])
  })
})

const READ: EffectClassification = {
  effectId: "db.read",
  confidence: "high",
  derivedBy: "effects-stub:read",
}
const WRITE: EffectClassification = {
  ...READ,
  effectId: "db.write",
  derivedBy: "effects-stub:write",
}

function answering(
  name: string,
  answer: EffectClassification | null,
  ms: number,
  asked: string[] = [],
) {
  return stubEffectsPlugin(name, (call) => {
    asked.push(call.target)
    spend(ms)
    return answer
  })
}

// 30 ms against the 10 ms floor overruns on any machine.
const SLOW_MS = 30
const FLOOR = { classifyTimeoutMs: 10 }

describe("runFilePipeline — a classification that ran past its budget", () => {
  it("is kept, and no later plugin is asked", async () => {
    const asked: string[] = []
    const { symbols, timeoutEvents } = await extractOneSymbol({
      config: FLOOR,
      effects: [
        answering("effects-slow", READ, SLOW_MS),
        answering("effects-next", WRITE, 0, asked),
      ],
      body: bodyCalling(makeCall({ target: "db.query" })),
    })

    expect(timeoutEvents.map((e) => e.plugin)).toEqual(["effects-slow"])
    expect(symbols[0]?.effects.map((e) => [e.id, e.target, e.plugin])).toEqual([
      ["db.read", "db.query", "effects-slow"],
    ])
    expect(symbols[0]?.calls).toEqual([])
    expect(asked).toEqual([])
  })

  it("passes a null on to the next plugin, as a fast null would", async () => {
    const { symbols, timeoutEvents } = await extractOneSymbol({
      config: FLOOR,
      effects: [answering("effects-slow", null, SLOW_MS), answering("effects-next", READ, 0)],
      body: bodyCalling(makeCall({ target: "db.query" })),
    })

    // The next plugin is timed against the same 10 ms, so only the slow one's overrun is certain.
    expect(timeoutEvents.filter((e) => e.plugin === "effects-slow")).toHaveLength(1)
    expect(symbols[0]?.effects.map((e) => [e.id, e.plugin])).toEqual([["db.read", "effects-next"]])
  })

  it("leaves the Symbol, fingerprint included, as a fast run leaves it", async () => {
    const classifiedIn = (classifyTimeoutMs: number, ms: number) =>
      extractOneSymbol({
        config: { classifyTimeoutMs },
        effects: [answering("effects-slow", READ, ms)],
        body: bodyCalling(makeCall({ target: "db.query" })),
      })
    const slow = await classifiedIn(FLOOR.classifyTimeoutMs, SLOW_MS)
    const fast = await classifiedIn(5000, 0)

    expect(slow.timeoutEvents).toHaveLength(1)
    expect(fast.timeoutEvents).toEqual([])
    expect(fast.symbols[0]?.effects.map((e) => e.id)).toEqual(["db.read"])
    // `logic` hashes an effect by its target alone, so only the whole Symbol shows a lost confidence.
    expect(slow.symbols).toEqual(fast.symbols)
  })
})
