import { makeCall } from "@aburi/test-support"
import type { CallCandidate, ClassifyContext, Decorator } from "@aburi/types"
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
