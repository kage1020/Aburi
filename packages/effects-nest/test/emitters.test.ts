import type { ImportEdge } from "@aburi/types"
import { describe, expect, it } from "vitest"
import {
  hasNestEmitterImport,
  isNestEmitMethod,
  isNestEventEmitterIdentifier,
  NEST_EMIT_METHOD,
  NEST_EVENT_EMITTER_IDENTIFIERS,
} from "../src/index"

const PATH = "src/orders/service.ts"

function edge(source: string, line = 1): ImportEdge {
  return { source, symbols: ["EventEmitter2"], line, dynamic: false }
}

describe("hasNestEmitterImport", () => {
  it.each([
    ["@nestjs/event-emitter", [edge("@nestjs/event-emitter")]],
    ["eventemitter2", [edge("eventemitter2")]],
    [
      "an emitter module beside other imports",
      [edge("@nestjs/common", 1), edge("@nestjs/event-emitter", 2)],
    ],
  ])("returns true when the file imports %s", (_label, imports) => {
    expect(hasNestEmitterImport(imports, PATH)).toBe(true)
  })

  it.each([
    ["nothing", []],
    ["Node's events module", [edge("events")]],
    ["@nestjs/websockets, whose emit is another API", [edge("@nestjs/websockets")]],
  ])("returns false when the file imports %s", (_label, imports) => {
    expect(hasNestEmitterImport(imports, PATH)).toBe(false)
  })

  it("throws on an empty ImportEdge.source, naming the plugin, the file, and the line", () => {
    expect(() => hasNestEmitterImport([edge("", 9)], PATH)).toThrow(
      `effects-nest (${PATH}, line 9): ImportEdge.source is empty`,
    )
  })

  it("throws even when a broken ImportEdge sits after a legitimate match", () => {
    expect(() =>
      hasNestEmitterImport([edge("@nestjs/event-emitter", 1), edge("", 2)], PATH),
    ).toThrow(/ImportEdge\.source is empty/)
  })
})

describe("event-emitter identifier vocabulary", () => {
  it("lists exactly eventBus and EventEmitter2", () => {
    expect([...NEST_EVENT_EMITTER_IDENTIFIERS]).toEqual(["eventBus", "EventEmitter2"])
    expect(isNestEventEmitterIdentifier("eventBus")).toBe(true)
    expect(isNestEventEmitterIdentifier("EventEmitter2")).toBe(true)
  })

  it.each([
    "bus",
    "emitter",
    "dispatcher",
    "socket",
    "stream",
    "EVENTBUS",
    "EventBus",
    "eventemitter2",
  ])("rejects %s — generic names and case variants are not recognized", (name) => {
    expect(isNestEventEmitterIdentifier(name)).toBe(false)
  })
})

describe("emit method sentinel", () => {
  it("is exactly `emit`", () => {
    expect(NEST_EMIT_METHOD).toBe("emit")
    expect(isNestEmitMethod("emit")).toBe(true)
  })

  it.each(["emitAsync", "emitAsyncSerial", "emits", "emitEvent"])("rejects %s", (name) => {
    expect(isNestEmitMethod(name)).toBe(false)
  })
})
