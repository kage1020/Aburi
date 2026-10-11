import {
  call,
  componentId,
  decorator,
  effect,
  errorFrom,
  fp,
  makeSymbol,
  sig,
} from "@aburi/test-support"
import type {
  Decorator,
  Effect,
  Symbol as IRSymbol,
  Signature,
  SignatureDelta,
  SymbolDelta,
} from "@aburi/types"
import { describe, expect, it } from "vitest"
import { computeSymbolDelta, DiffError, MAX_LINE_FUZZ, MIN_LINE_FUZZ } from "../src"
import { diffSymbols } from "./helpers"

function symbolWith(overrides: Partial<IRSymbol>, seed: string): IRSymbol {
  return makeSymbol({ id: "ts:src/a.ts#Foo", name: "Foo", fingerprint: fp(seed), ...overrides })
}

const NOTHING = { added: [], removed: [], modified: [] }

describe("lineFuzz", () => {
  const foo = symbolWith({}, "a")

  it.each([
    [-1, "lineFuzz must be within [0, 10]; got -1."],
    [MAX_LINE_FUZZ + 1, "lineFuzz must be within [0, 10]; got 11."],
    [Number.NaN, "lineFuzz must be an integer in [0, 10]; got NaN."],
    [Number.POSITIVE_INFINITY, "lineFuzz must be an integer in [0, 10]; got Infinity."],
    [1.5, "lineFuzz must be an integer in [0, 10]; got 1.5."],
  ])("refuses %s rather than clamping it", async (lineFuzz, message) => {
    expect(
      await errorFrom(DiffError, () => computeSymbolDelta(foo, foo, { lineFuzz })),
    ).toMatchObject({
      code: "invalid-line-fuzz",
      value: String(lineFuzz),
      message,
    })
  })

  it.each([MIN_LINE_FUZZ, MAX_LINE_FUZZ])("accepts the bound %i", (lineFuzz) => {
    expect(() => computeSymbolDelta(foo, foo, { lineFuzz })).not.toThrow()
  })

  it("is checked when buildDiff passes it through", async () => {
    const error = await errorFrom(DiffError, () =>
      diffSymbols([foo], [symbolWith({}, "b")], { delta: { lineFuzz: 999 } }),
    )
    expect(error.code).toBe("invalid-line-fuzz")
  })
})

describe("the flags beside the fingerprint axes", () => {
  const base = makeSymbol({ id: "ts:src/a.ts#Foo", name: "Foo", component: "api" })

  it.each<[string, Partial<IRSymbol>, keyof SymbolDelta]>([
    ["component", { component: componentId("shared") }, "componentChanged"],
    ["visibility", { visibility: "private" }, "visibilityChanged"],
    ["confidence", { confidence: "medium" }, "confidenceChanged"],
  ])("records a %s move, and writes false when it did not move", (_, moved, flag) => {
    expect(computeSymbolDelta(base, { ...base, ...moved })[flag]).toBe(true)
    expect(computeSymbolDelta(base, base)[flag]).toBe(false)
  })
})

describe("decorators", () => {
  const decoratorDelta = (base: Decorator[], head: Decorator[]) =>
    computeSymbolDelta(symbolWith({ decorators: base }, "a"), symbolWith({ decorators: head }, "b"))
      .decorators
  const post = (qualifier?: string) =>
    decorator({
      name: "Post",
      ...(qualifier === undefined ? {} : { qualifier }),
      arguments: ['"/x"'],
      line: 3,
    })

  it("reports a changed argument list as modified", () => {
    const after = decorator({ name: "Post", arguments: ["/invoices/v2"], line: 5 })
    expect(
      decoratorDelta([decorator({ name: "Post", arguments: ["/invoices"], line: 5 })], [after]),
    ).toEqual({ added: [], removed: [], modified: [after] })
  })

  it("reports a renamed decorator as added + removed", () => {
    const before = decorator({ name: "Get", line: 5 })
    const after = decorator({ name: "Post", line: 5 })
    expect(decoratorDelta([before], [after])).toEqual({
      added: [after],
      removed: [before],
      modified: [],
    })
  })

  it.each([
    ["changed", post("nest"), post("tsed")],
    ["was gained", post(), post("nest")],
    ["was lost", post("nest"), post()],
    ["became multi-segment", post("nest"), post("a.b")],
  ])("reports a receiver that %s as modified, carrying the head element", (_, before, after) => {
    expect(decoratorDelta([before], [after])).toStrictEqual({
      added: [],
      removed: [],
      modified: [after],
    })
  })

  it("does not compare raw, so a reformat of the same decorator is no change", () => {
    expect(
      decoratorDelta([{ ...post(), raw: 'Post("/x")' }], [{ ...post(), raw: 'Post( "/x" )' }]),
    ).toEqual(NOTHING)
  })

  it("does not compare boundary, which plugins derive rather than read", () => {
    expect(
      decoratorDelta([{ ...post(), boundary: false }], [{ ...post(), boundary: true }]),
    ).toEqual(NOTHING)
  })
})

describe("effects", () => {
  const local = (overrides: Partial<Effect> = {}) =>
    effect({
      id: "db.write",
      target: "prisma.user.create",
      plugin: "effects-prisma",
      line: 10,
      ...overrides,
    })
  const propagated = (...derivedFrom: string[]) =>
    effect({
      id: "db.write",
      target: "prisma.user.create",
      plugin: "effects-prisma",
      propagated: true,
      derivedFrom,
    })
  const effectDelta = (base: Effect[], head: Effect[]) =>
    computeSymbolDelta(symbolWith({ effects: base }, "a"), symbolWith({ effects: head }, "b"))
      .effects

  it.each<[string, Partial<Effect>]>([
    ["confidence", { confidence: "medium" }],
    ["plugin", { plugin: "effects-drizzle" }],
  ])("reports a changed %s as modified while (id, target) survive", (_, edit) => {
    expect(effectDelta([local()], [local(edit)])).toEqual({
      added: [],
      removed: [],
      modified: [local(edit)],
    })
  })

  it("reports an effect that turned propagated as modified", () => {
    const after = propagated("ts:src/repository.ts#Repository.save")
    expect(effectDelta([local()], [after])?.modified).toEqual([after])
  })

  it("reports a propagated effect whose direct source changed as modified", () => {
    const after = propagated("ts:src/b.ts#b")
    expect(effectDelta([propagated("ts:src/a.ts#a")], [after])?.modified).toEqual([after])
  })

  it("compares a propagated effect's direct sources as a set", () => {
    expect(
      effectDelta(
        [propagated("ts:src/a.ts#a", "ts:src/b.ts#b")],
        [propagated("ts:src/b.ts#b", "ts:src/a.ts#a")],
      ),
    ).toEqual(NOTHING)
  })

  it("reads an omitted propagated flag as false", () => {
    expect(effectDelta([local()], [local({ propagated: false })])).toEqual(NOTHING)
  })

  it("does not compare derivedBy, which is evidence text rather than identity", () => {
    expect(
      effectDelta(
        [local({ derivedBy: "convention:prisma-client" })],
        [local({ derivedBy: "convention:prisma-client-v2" })],
      ),
    ).toEqual(NOTHING)
  })

  it("reports a changed target as added + removed", () => {
    const after = local({ target: "prisma.invoice.create" })
    expect(effectDelta([local()], [after])).toEqual({
      added: [after],
      removed: [local()],
      modified: [],
    })
  })
})

describe("calls", () => {
  const callDelta = (base: IRSymbol["calls"], head: IRSymbol["calls"]) =>
    computeSymbolDelta(symbolWith({ calls: base }, "a"), symbolWith({ calls: head }, "b"), {
      lineFuzz: 2,
    }).calls

  it("reports a call whose resolution changed as modified", () => {
    const after = call({ target: "helper.doWork", line: 20, resolved: "ts:src/util.ts#doWork" })
    expect(callDelta([call({ target: "helper.doWork", line: 20 })], [after])).toEqual({
      added: [],
      removed: [],
      modified: [after],
    })
  })

  it("reports an edited call beyond the line window as added + removed", () => {
    const before = call({ target: "helper.doWork", line: 20 })
    const after = call({ target: "helper.doWork", line: 100, resolved: "ts:src/helper.ts#doWork" })
    expect(callDelta([before], [after])).toEqual({
      added: [after],
      removed: [before],
      modified: [],
    })
  })
})

describe("signature", () => {
  const signatureDelta = (base: Signature | null, head: Signature | null) =>
    computeSymbolDelta(symbolWith({ signature: base }, "a"), symbolWith({ signature: head }, "b"))
      .signature
  const UNCHANGED_FLAGS = {
    asyncChanged: false,
    generatorChanged: false,
    typeParametersChanged: false,
  }

  it("is null when neither side has one", () => {
    expect(signatureDelta(null, null)).toBeNull()
  })

  it("puts every list of a gained signature in added, and reads its flags against the defaults", () => {
    expect(
      signatureDelta(null, sig({ inputs: [{ name: "x", type: "string" }], async: true })),
    ).toEqual<SignatureDelta>({
      inputs: { added: [{ name: "x", type: "string" }], removed: [], modified: [] },
      outputs: { added: ["void"], removed: [], modified: [] },
      throws: NOTHING,
      ...UNCHANGED_FLAGS,
      asyncChanged: true,
    })
  })

  it("puts every list of a lost signature in removed, and reads its flags against the defaults", () => {
    expect(
      signatureDelta(sig({ throws: ["AuthError"], generator: true, typeParameters: ["T"] }), null),
    ).toEqual<SignatureDelta>({
      inputs: NOTHING,
      outputs: { added: [], removed: ["void"], modified: [] },
      throws: { added: [], removed: ["AuthError"], modified: [] },
      asyncChanged: false,
      generatorChanged: true,
      typeParametersChanged: true,
    })
  })

  it("reports an input whose type changed as modified, and outputs by position", () => {
    expect(
      signatureDelta(
        sig({ inputs: [{ name: "x", type: "string" }] }),
        sig({ inputs: [{ name: "x", type: "number" }], outputs: ["boolean"] }),
      ),
    ).toEqual<SignatureDelta>({
      inputs: { added: [], removed: [], modified: [{ name: "x", type: "number" }] },
      outputs: { added: ["boolean"], removed: ["void"], modified: [] },
      throws: NOTHING,
      ...UNCHANGED_FLAGS,
    })
  })

  it.each([
    ["turns optional", { optional: true } as const],
    ["turns into a rest parameter", { rest: true } as const],
  ])("reports an input that %s as modified, since the api moved with it", (_, form) => {
    expect(
      signatureDelta(
        sig({ inputs: [{ name: "x", type: "string" }] }),
        sig({ inputs: [{ name: "x", type: "string", ...form }] }),
      )?.inputs,
    ).toEqual({ added: [], removed: [], modified: [{ name: "x", type: "string", ...form }] })
  })

  it("does not compare the bindings a plugin read out of a destructuring input", () => {
    const destructured = { name: "{ id }", type: "Request" }
    expect(
      signatureDelta(
        sig({ inputs: [destructured] }),
        sig({ inputs: [{ ...destructured, bindings: ["id"] }] }),
      )?.inputs,
    ).toEqual(NOTHING)
  })

  it("identifies an input by its position, so one that moved is removed and added", () => {
    const a = { name: "a", type: "string" }
    const b = { name: "b", type: "number" }
    expect(signatureDelta(sig({ inputs: [a, b] }), sig({ inputs: [b] }))?.inputs).toEqual({
      added: [b],
      removed: [a, b],
      modified: [],
    })
  })

  it("compares throws as a set", () => {
    const base = sig({ throws: ["AuthError", "RateLimitError"] })
    expect(signatureDelta(base, sig({ throws: ["RateLimitError", "AuthError"] }))?.throws).toEqual(
      NOTHING,
    )
    expect(
      signatureDelta(base, sig({ throws: ["RateLimitError", "TimeoutError"] }))?.throws,
    ).toEqual({ added: ["TimeoutError"], removed: ["AuthError"], modified: [] })
  })

  it.each<[string, Partial<Signature>, keyof typeof UNCHANGED_FLAGS]>([
    ["async", { async: true }, "asyncChanged"],
    ["generator", { generator: true }, "generatorChanged"],
    ["typeParameters", { typeParameters: ["T"] }, "typeParametersChanged"],
  ])("sets only the %s flag when that alone moved", (_, moved, flag) => {
    expect(signatureDelta(sig(), sig(moved))).toEqual<SignatureDelta>({
      inputs: NOTHING,
      outputs: NOTHING,
      throws: NOTHING,
      ...UNCHANGED_FLAGS,
      [flag]: true,
    })
  })
})
