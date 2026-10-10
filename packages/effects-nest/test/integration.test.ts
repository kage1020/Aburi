import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { makeCtx, makeExtractionCtx } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { classifyNestCall } from "../src/index"

/** Each call the TypeScript plugin finds in `source`, by target, beside what `classifyNestCall` makes of it. */
async function classifiedCalls(source: string, path = "src/orders.service.ts") {
  const { tree, imports } = await langTypescriptPlugin.parseFile({ path, content: source })
  if (tree === null) throw new Error(`${path} did not parse`)
  const extraction = makeExtractionCtx(path, source)
  const ctx = makeCtx({ path, imports })
  return langTypescriptPlugin
    .extractSymbols(tree, extraction)
    .flatMap((symbol) => langTypescriptPlugin.walkBody(symbol, { ...extraction, symbol }).calls)
    .map((call): [string, string | null] => [
      call.target,
      classifyNestCall(call, ctx)?.derivedBy ?? null,
    ])
    .sort(([a], [b]) => a.localeCompare(b))
}

describe("classifyNestCall over calls the TypeScript plugin extracts", () => {
  it("publishes through eventBus or EventEmitter2, and nothing else that emits", async () => {
    const calls = await classifiedCalls(
      [
        'import { Injectable } from "@nestjs/common"',
        'import { EventEmitter2 } from "@nestjs/event-emitter"',
        "",
        "@Injectable()",
        "export class OrdersService {",
        "  constructor(private readonly eventBus: EventEmitter2) {}",
        "  create() {",
        '    this.eventBus.emit("order.created", { id: 1 })',
        "  }",
        "}",
        "",
        "export function publish(eventBus: EventEmitter2, socket: any) {",
        '  eventBus.emit("thing.happened", 1)',
        '  EventEmitter2.emit("thing.happened", 1)',
        '  socket.emit("update", {})',
        "}",
        "",
      ].join("\n"),
    )

    expect(calls).toEqual([
      ["eventBus.emit", "effects-plugin:nest:eventBus.emit"],
      ["EventEmitter2.emit", "effects-plugin:nest:EventEmitter2.emit"],
      ["socket.emit", null],
      ["this.eventBus.emit", "effects-plugin:nest:eventBus.emit"],
    ])
  })

  it("publishes in a file that imports eventemitter2 itself", async () => {
    const calls = await classifiedCalls(
      [
        'import { EventEmitter2 } from "eventemitter2"',
        "export function publish(eventBus: EventEmitter2) {",
        '  eventBus.emit("raw.event", {})',
        "}",
        "",
      ].join("\n"),
    )

    expect(calls).toEqual([["eventBus.emit", "effects-plugin:nest:eventBus.emit"]])
  })

  it("publishes nothing in a file whose emitter comes from Node's events module", async () => {
    const calls = await classifiedCalls(
      [
        'import { EventEmitter } from "events"',
        "export function raise(eventBus: EventEmitter) {",
        '  eventBus.emit("data", 1)',
        "}",
        "",
      ].join("\n"),
    )

    expect(calls).toEqual([["eventBus.emit", null]])
  })
})
