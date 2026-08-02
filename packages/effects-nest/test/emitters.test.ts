import { describe, expect, it } from "vitest"
import {
  hasNestEmitterImport,
  isNestEmitMethod,
  isNestEventEmitterIdentifier,
  NEST_EMIT_METHOD,
  NEST_EVENT_EMITTER_IDENTIFIERS,
} from "../src/index"

const PATH = "src/orders/service.ts"

describe("hasNestEmitterImport", () => {
  it("returns true when the file imports @nestjs/event-emitter", () => {
    expect(
      hasNestEmitterImport(
        [{ source: "@nestjs/event-emitter", symbols: ["EventEmitter2"], line: 1, dynamic: false }],
        PATH,
      ),
    ).toBe(true)
  })

  it("returns true when the file imports eventemitter2 directly", () => {
    expect(
      hasNestEmitterImport(
        [{ source: "eventemitter2", symbols: ["EventEmitter2"], line: 1, dynamic: false }],
        PATH,
      ),
    ).toBe(true)
  })

  it("returns false when the import list is empty", () => {
    expect(hasNestEmitterImport([], PATH)).toBe(false)
  })

  it("returns false for Node's built-in `events` module (intentional exclusion)", () => {
    // Node's EventEmitter has different semantics (per-instance state, not DI'd
    // application-wide bus) — classifying stream emitters would drown the report.
    expect(
      hasNestEmitterImport(
        [{ source: "events", symbols: ["EventEmitter"], line: 1, dynamic: false }],
        PATH,
      ),
    ).toBe(false)
  })

  it("returns false for the @nestjs/websockets `.emit` — different API surface", () => {
    expect(
      hasNestEmitterImport(
        [{ source: "@nestjs/websockets", symbols: ["WebSocketGateway"], line: 1, dynamic: false }],
        PATH,
      ),
    ).toBe(false)
  })

  it("returns true when a recognized module sits alongside other imports", () => {
    expect(
      hasNestEmitterImport(
        [
          { source: "@nestjs/common", symbols: ["Injectable"], line: 1, dynamic: false },
          { source: "@nestjs/event-emitter", symbols: ["EventEmitter2"], line: 2, dynamic: false },
        ],
        PATH,
      ),
    ).toBe(true)
  })

  it("throws when the language plugin emits an empty ImportEdge.source", () => {
    expect(() =>
      hasNestEmitterImport(
        [{ source: "", symbols: ["EventEmitter2"], line: 1, dynamic: false }],
        PATH,
      ),
    ).toThrow(/ImportEdge\.source is empty/)
  })

  it("throws even when a broken ImportEdge sits after a legitimate match", () => {
    // Order-independence pin — using `.some()` alone would short-circuit on the first
    // match and silently accept a broken edge later in the list.
    expect(() =>
      hasNestEmitterImport(
        [
          { source: "@nestjs/event-emitter", symbols: ["EventEmitter2"], line: 1, dynamic: false },
          { source: "", symbols: ["x"], line: 2, dynamic: false },
        ],
        PATH,
      ),
    ).toThrow(/ImportEdge\.source is empty/)
  })
})

describe("event-emitter identifier vocabulary", () => {
  it("recognizes the two documented identifiers", () => {
    expect(NEST_EVENT_EMITTER_IDENTIFIERS.has("eventBus")).toBe(true)
    expect(NEST_EVENT_EMITTER_IDENTIFIERS.has("EventEmitter2")).toBe(true)
    expect(isNestEventEmitterIdentifier("eventBus")).toBe(true)
    expect(isNestEventEmitterIdentifier("EventEmitter2")).toBe(true)
  })

  it("rejects generic emitter names to prevent over-classification", () => {
    const untyped = NEST_EVENT_EMITTER_IDENTIFIERS as ReadonlySet<string>
    for (const name of [
      "bus",
      "emitter",
      "dispatcher",
      "notifier",
      "publisher",
      "socket",
      "stream",
    ]) {
      expect(untyped.has(name)).toBe(false)
      expect(isNestEventEmitterIdentifier(name)).toBe(false)
    }
  })

  it("rejects case variants — recognition is case-sensitive", () => {
    expect(isNestEventEmitterIdentifier("EVENTBUS")).toBe(false)
    expect(isNestEventEmitterIdentifier("eventemitter2")).toBe(false)
    expect(isNestEventEmitterIdentifier("EventBus")).toBe(false)
  })
})

describe("emit method sentinel", () => {
  it("recognizes the `emit` literal", () => {
    expect(NEST_EMIT_METHOD).toBe("emit")
    expect(isNestEmitMethod("emit")).toBe(true)
  })

  it("rejects `.emitAsync` — a real EventEmitter2 API that is not classified yet", () => {
    // `.emitAsync` and `.emitAsyncSerial` are legitimate publish APIs on EventEmitter2.
    // they are not classified yet (see NEST_EMIT_METHOD docstring). This test pins the
    // scope so a future change that widens it does so deliberately.
    expect(isNestEmitMethod("emitAsync")).toBe(false)
    expect(isNestEmitMethod("emitAsyncSerial")).toBe(false)
  })

  it("rejects unrelated near-miss names (`.emits`, `.emitEvent`)", () => {
    expect(isNestEmitMethod("emits")).toBe(false)
    expect(isNestEmitMethod("emitEvent")).toBe(false)
  })
})
