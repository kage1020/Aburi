import { describe, expect, it } from "vitest"
import { classifyNestCall } from "../src/index"
import {
  makeCall,
  makeCtx,
  makeEventemitter2Import,
  makeNestEmitterImport,
} from "./fixtures/context"

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
    // `notifier.emit`). All colocated with a legit @nestjs/event-emitter import.
    expect(classifyNestCall(makeCall({ target: "socket.emit" }), ctxWithNest)).toBeNull()
    expect(classifyNestCall(makeCall({ target: "process.emit" }), ctxWithNest)).toBeNull()
    expect(classifyNestCall(makeCall({ target: "stream.emit" }), ctxWithNest)).toBeNull()
    expect(classifyNestCall(makeCall({ target: "bus.emit" }), ctxWithNest)).toBeNull()
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

  it("throws for an empty target", () => {
    expect(() => classifyNestCall(makeCall({ target: "" }), ctxWithNest)).toThrow(/target is empty/)
  })

  it("throws for a leading dot", () => {
    expect(() => classifyNestCall(makeCall({ target: ".emit" }), ctxWithNest)).toThrow(
      /empty segment/,
    )
  })

  it("throws for a trailing dot", () => {
    expect(() => classifyNestCall(makeCall({ target: "eventBus." }), ctxWithNest)).toThrow(
      /empty segment/,
    )
  })

  it("throws for adjacent dots — otherwise `eventBus..emit` would slip through the name gate", () => {
    expect(() => classifyNestCall(makeCall({ target: "eventBus..emit" }), ctxWithNest)).toThrow(
      /empty segment/,
    )
  })
})

describe("classifyNestCall — purity", () => {
  it("is idempotent across repeated calls", () => {
    const ctx = makeCtx({ imports: [makeNestEmitterImport()] })
    const call = makeCall({ target: "this.eventBus.emit", line: 42, argumentCount: 2 })
    const first = classifyNestCall(call, ctx)
    const second = classifyNestCall(call, ctx)
    expect(first).toEqual(second)
  })

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
