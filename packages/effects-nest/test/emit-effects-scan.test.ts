import { langTypescriptPlugin } from "@aburi/lang-typescript"
import { scanWith } from "@aburi/test-harness"
import { symbolNamed, useScratchWorkspace } from "@aburi/test-support"
import { describe, expect, it } from "vitest"
import { nestEffectsPlugin } from "../src/index"

const workspace = useScratchWorkspace("emit-effects")

const scanWorkspace = () =>
  scanWith(workspace.root, { languages: [langTypescriptPlugin], effects: [nestEffectsPlugin] })

describe("scan — event emitters in a NestJS service file", () => {
  it("publishes through eventBus or EventEmitter2, and leaves any other emit a call", async () => {
    await workspace.writeSource(
      "src/orders.service.ts",
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

    const result = await scanWorkspace()
    const publish = symbolNamed(result, "publish")

    expect(symbolNamed(result, "OrdersService.create").effects).toMatchObject([
      {
        id: "event.publish",
        target: "this.eventBus.emit",
        confidence: "high",
        derivedBy: "effects-plugin:nest:eventBus.emit",
      },
    ])
    expect(publish.effects).toMatchObject([
      {
        id: "event.publish",
        target: "eventBus.emit",
        derivedBy: "effects-plugin:nest:eventBus.emit",
      },
      {
        id: "event.publish",
        target: "EventEmitter2.emit",
        derivedBy: "effects-plugin:nest:EventEmitter2.emit",
      },
    ])
    expect(publish.calls.map((c) => c.target)).toEqual(["socket.emit"])
  })

  it("publishes in a file that imports eventemitter2 itself", async () => {
    await workspace.writeSource(
      "src/publish.ts",
      [
        'import { EventEmitter2 } from "eventemitter2"',
        "",
        "export function publish(eventBus: EventEmitter2) {",
        '  eventBus.emit("raw.event", {})',
        "}",
        "",
      ].join("\n"),
    )

    const result = await scanWorkspace()

    expect(symbolNamed(result, "publish").effects).toMatchObject([
      { id: "event.publish", target: "eventBus.emit" },
    ])
  })

  it("publishes nothing in a file whose emitter comes from Node's events module", async () => {
    await workspace.writeSource(
      "src/raise.ts",
      [
        'import { EventEmitter } from "events"',
        "",
        "export function raise(eventBus: EventEmitter) {",
        '  eventBus.emit("data", 1)',
        "}",
        "",
      ].join("\n"),
    )

    const result = await scanWorkspace()

    expect(result.ir.symbols.flatMap((s) => s.effects)).toEqual([])
    expect(symbolNamed(result, "raise").calls.map((c) => c.target)).toEqual(["eventBus.emit"])
  })
})
