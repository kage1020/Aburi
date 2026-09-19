import { makeCall, makeCtx } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { classifyNestCall } from "../src/index"
import { makeEventemitter2Import, makeNestEmitterImport } from "./fixtures/context"

describe("classifyNestCall — positive paths", () => {
  const ctx = makeCtx({ imports: [makeNestEmitterImport()] })

  it("classifies eventBus.emit(...) as event.publish", () => {
    const result = classifyNestCall(makeCall({ target: "eventBus.emit" }), ctx)
    expect(result?.effectId).toBe("event.publish")
    expect(result?.confidence).toBe("high")
    expect(result?.derivedBy).toBe("effects-plugin:nest:eventBus.emit")
  })

  it("classifies EventEmitter2.emit(...) as event.publish", () => {
    const result = classifyNestCall(makeCall({ target: "EventEmitter2.emit" }), ctx)
    expect(result?.effectId).toBe("event.publish")
    expect(result?.derivedBy).toBe("effects-plugin:nest:EventEmitter2.emit")
  })

  it("classifies this.eventBus.emit(...) inside a class method", () => {
    expect(classifyNestCall(makeCall({ target: "this.eventBus.emit" }), ctx)?.effectId).toBe(
      "event.publish",
    )
  })

  it("classifies deeply chained accessors ending in <name>.emit", () => {
    expect(
      classifyNestCall(makeCall({ target: "container.services.eventBus.emit" }), ctx)?.effectId,
    ).toBe("event.publish")
  })

  it("also classifies when the file imports eventemitter2 directly", () => {
    const ctxDirect = makeCtx({ imports: [makeEventemitter2Import()] })
    expect(classifyNestCall(makeCall({ target: "eventBus.emit" }), ctxDirect)?.effectId).toBe(
      "event.publish",
    )
  })
})

describe("classifyNestCall — negative paths (two-signal defense)", () => {
  const ctxWithNest = makeCtx({ imports: [makeNestEmitterImport()] })

  it("returns null when the file does not import a recognized emitter module", () => {
    const ctxNoImport = makeCtx({ imports: [] })
    expect(classifyNestCall(makeCall({ target: "eventBus.emit" }), ctxNoImport)).toBeNull()
  })

  it("returns null when the file imports Node's `events` (not a Nest emitter)", () => {
    const ctxNodeEvents = makeCtx({
      imports: [{ source: "events", symbols: ["EventEmitter"], line: 1, dynamic: false }],
    })
    expect(classifyNestCall(makeCall({ target: "eventBus.emit" }), ctxNodeEvents)).toBeNull()
  })

  it("returns null when the name segment is not in the recognized identifier set", () => {
    // Common name-collision culprits: `socket.emit` (@nestjs/websockets), `process.emit`
    // (Node global), `stream.emit`, arbitrary user-named emitters (`bus.emit`,
    // `notifier.emit`), and the generic `emitter.emit` / `this.emitter.emit` shape the
    // docstring calls out as explicitly out of scope. All colocated with a legit
    // @nestjs/event-emitter import to prove the name gate does the work.
    expect(classifyNestCall(makeCall({ target: "socket.emit" }), ctxWithNest)).toBeNull()
    expect(classifyNestCall(makeCall({ target: "process.emit" }), ctxWithNest)).toBeNull()
    expect(classifyNestCall(makeCall({ target: "stream.emit" }), ctxWithNest)).toBeNull()
    expect(classifyNestCall(makeCall({ target: "bus.emit" }), ctxWithNest)).toBeNull()
    expect(classifyNestCall(makeCall({ target: "emitter.emit" }), ctxWithNest)).toBeNull()
    expect(classifyNestCall(makeCall({ target: "this.emitter.emit" }), ctxWithNest)).toBeNull()
  })

  it("returns null when the method is not the exact `emit` sentinel", () => {
    expect(classifyNestCall(makeCall({ target: "eventBus.emitAsync" }), ctxWithNest)).toBeNull()
    expect(classifyNestCall(makeCall({ target: "eventBus.emits" }), ctxWithNest)).toBeNull()
    expect(classifyNestCall(makeCall({ target: "eventBus.dispatch" }), ctxWithNest)).toBeNull()
  })

  it("returns null for a bare `emit()` (no client segment)", () => {
    expect(classifyNestCall(makeCall({ target: "emit" }), ctxWithNest)).toBeNull()
  })

  it("returns null for a bare identifier (no method chain)", () => {
    expect(classifyNestCall(makeCall({ target: "eventBus" }), ctxWithNest)).toBeNull()
  })
})

describe("classifyNestCall — malformed input fail-fast", () => {
  const ctxWithNest = makeCtx({ imports: [makeNestEmitterImport()] })
  const ctxNoImport = makeCtx({ imports: [] })

  it.each([
    ["", /target is empty/],
    ["eventBus..emit", /empty segment/],
    [".emit", /empty segment/],
    ["eventBus.", /empty segment/],
  ])("throws for the malformed target %j with or without a Nest emitter import", (target, message) => {
    // Without the throw, `eventBus..emit` would slip through the name gate. The import gate
    // must NOT shadow the check, or the same upstream bug would surface only in the few
    // files that import an emitter — locking the order at the test seam.
    expect(() => classifyNestCall(makeCall({ target }), ctxWithNest)).toThrow(message)
    expect(() => classifyNestCall(makeCall({ target }), ctxNoImport)).toThrow(message)
  })

  it("names itself in the message — a transposed plugin-name const would type-check silently", () => {
    // The name is now an importable const shared by four packages rather than a literal in
    // this file, so nothing but this assertion catches `EFFECTS_PRISMA_PLUGIN_NAME` here.
    expect(() => classifyNestCall(makeCall({ target: "" }), ctxWithNest)).toThrow(
      /^effects-nest \(/,
    )
    const brokenEdge = makeCtx({
      imports: [{ source: "", symbols: ["EventEmitter2"], line: 2, dynamic: false }],
    })
    expect(() => classifyNestCall(makeCall({ target: "eventBus.emit" }), brokenEdge)).toThrow(
      /^effects-nest \(/,
    )
  })

  it("throw messages include the file path so caught exceptions point at the offending source", () => {
    const ctxWithPath = makeCtx({ imports: [makeNestEmitterImport()], path: "src/orders/x.ts" })
    expect(() => classifyNestCall(makeCall({ target: "" }), ctxWithPath)).toThrow(
      /src\/orders\/x\.ts/,
    )
    expect(() => classifyNestCall(makeCall({ target: "eventBus..emit" }), ctxWithPath)).toThrow(
      /src\/orders\/x\.ts/,
    )
  })

  it("throw messages for a broken ImportEdge name the file and the offending line", () => {
    const ctxBrokenEdge = makeCtx({
      imports: [{ source: "", symbols: ["EventEmitter2"], line: 4, dynamic: false }],
      path: "src/orders/x.ts",
    })
    expect(() => classifyNestCall(makeCall({ target: "eventBus.emit" }), ctxBrokenEdge)).toThrow(
      /ImportEdge\.source is empty/,
    )
    expect(() => classifyNestCall(makeCall({ target: "eventBus.emit" }), ctxBrokenEdge)).toThrow(
      /src\/orders\/x\.ts, line 4/,
    )
  })
})

describe("classifyNestCall — purity", () => {
  it("does not mutate the input CallCandidate or the observable data slices of ClassifyContext", () => {
    const ctx = makeCtx({ imports: [makeNestEmitterImport()] })
    const call = makeCall({ target: "eventBus.emit", literalArgs: ["order.created"] })
    const fileSnapshot = structuredClone(ctx.file)
    const ownerSnapshot = structuredClone(ctx.owner)
    const languageSnapshot = ctx.language
    const callSnapshot = structuredClone(call)
    classifyNestCall(call, ctx)
    expect(call).toEqual(callSnapshot)
    expect(ctx.file).toEqual(fileSnapshot)
    expect(ctx.owner).toEqual(ownerSnapshot)
    expect(ctx.language).toBe(languageSnapshot)
  })
})
