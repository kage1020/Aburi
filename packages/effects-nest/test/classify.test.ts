import { makeCall, makeCtx } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { classifyNestCall } from "../src/index"
import { makeEventemitter2Import, makeNestEmitterImport } from "./fixtures/context"

const ctx = makeCtx({ imports: [makeNestEmitterImport()] })

describe("classifyNestCall — publishing calls", () => {
  it.each([
    ["eventBus.emit", "eventBus.emit"],
    ["this.eventBus.emit", "eventBus.emit"],
    ["container.services.eventBus.emit", "eventBus.emit"],
    ["EventEmitter2.emit", "EventEmitter2.emit"],
  ])("classifies %s as event.publish, tagged with the receiver it emits through", (target, tag) => {
    expect(classifyNestCall(makeCall({ target }), ctx)).toEqual({
      effectId: "event.publish",
      confidence: "high",
      derivedBy: `effects-plugin:nest:${tag}`,
    })
  })

  it.each([
    ["@nestjs/event-emitter", makeNestEmitterImport()],
    ["eventemitter2", makeEventemitter2Import()],
  ])("classifies in a file that imports %s", (_label, edge) => {
    expect(
      classifyNestCall(makeCall({ target: "eventBus.emit" }), makeCtx({ imports: [edge] }))
        ?.effectId,
    ).toBe("event.publish")
  })
})

describe("classifyNestCall — calls that are not a publish", () => {
  it.each([
    ["no import at all", []],
    [
      "Node's events module",
      [{ source: "events", symbols: ["EventEmitter"], line: 1, dynamic: false }],
    ],
  ])("returns null in a file that imports %s instead of an emitter module", (_label, imports) => {
    expect(classifyNestCall(makeCall({ target: "eventBus.emit" }), makeCtx({ imports }))).toBeNull()
  })

  it.each([
    ["socket.emit", "a receiver outside the identifier set"],
    ["process.emit", "a receiver outside the identifier set"],
    ["stream.emit", "a receiver outside the identifier set"],
    ["bus.emit", "a receiver outside the identifier set"],
    ["emitter.emit", "a receiver outside the identifier set"],
    ["this.emitter.emit", "a receiver outside the identifier set"],
    ["eventBus.emitAsync", "a method other than emit"],
    ["eventBus.emits", "a method other than emit"],
    ["eventBus.dispatch", "a method other than emit"],
    ["emit", "an emit with no receiver"],
    ["eventBus", "a bare identifier"],
  ])("returns null for %s — %s", (target) => {
    expect(classifyNestCall(makeCall({ target }), ctx)).toBeNull()
  })
})

describe("classifyNestCall — upstream contract violations", () => {
  const path = "src/orders/x.ts"

  it.each([
    ["", "CallCandidate.target is empty"],
    ["eventBus..emit", 'CallCandidate.target "eventBus..emit" has empty segment(s)'],
    [".emit", 'CallCandidate.target ".emit" has empty segment(s)'],
    ["eventBus.", 'CallCandidate.target "eventBus." has empty segment(s)'],
  ])("throws on the malformed target %j, naming itself and the file, before the import gate", (target, message) => {
    for (const imports of [[makeNestEmitterImport()], []]) {
      expect(() => classifyNestCall(makeCall({ target }), makeCtx({ imports, path }))).toThrow(
        `effects-nest (${path}): ${message}`,
      )
    }
  })

  it("throws on an import edge with an empty source rather than skipping it", () => {
    const brokenEdge = makeCtx({
      imports: [{ source: "", symbols: ["EventEmitter2"], line: 4, dynamic: false }],
      path,
    })
    expect(() => classifyNestCall(makeCall({ target: "eventBus.emit" }), brokenEdge)).toThrow(
      `effects-nest (${path}, line 4): ImportEdge.source is empty`,
    )
  })

  it("leaves the CallCandidate and the ClassifyContext as it found them", () => {
    const call = makeCall({ target: "eventBus.emit", literalArgs: ["order.created"] })
    const before = structuredClone({ call, file: ctx.file, owner: ctx.owner })
    classifyNestCall(call, ctx)
    expect({ call, file: ctx.file, owner: ctx.owner }).toEqual(before)
  })
})
