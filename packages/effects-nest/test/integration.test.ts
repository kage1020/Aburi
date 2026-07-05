import {
  extractSymbols as extractTypescriptSymbols,
  parseTypescriptFile,
  walkBody as walkTypescriptBody,
} from "@aburi/lang-typescript"
import type {
  ExtractionContext,
  ImportEdge,
  SourceFile,
  SymbolCandidate,
  WalkContext,
} from "@aburi/types"
import { describe, expect, it } from "vitest"
import type { Node } from "web-tree-sitter"
import { classifyNestCall } from "../src/index"
import { makeOwner, noopRegistry } from "./fixtures/context"

/**
 * End-to-end: parse a TypeScript source through `@aburi/lang-typescript`, walk each
 * Symbol's body to produce CallCandidate[], and confirm that the Nest classifier
 * assigns `event.publish` for the right shapes and null for false-positive lookalikes.
 */

async function classifyCalls(
  path: string,
  source: string,
  imports: ImportEdge[] = [
    { source: "@nestjs/event-emitter", symbols: ["EventEmitter2"], line: 1, dynamic: false },
  ],
) {
  const parseResult = await parseTypescriptFile({ path, content: source })
  const tree = parseResult.tree
  if (tree === null) throw new Error("parse returned null")
  const file: SourceFile = { path, content: source }
  const extractCtx: ExtractionContext = { file, registry: noopRegistry, config: {} }
  const candidates: SymbolCandidate<Node>[] = extractTypescriptSymbols(tree, extractCtx)
  const results: Array<{
    symbolName: string
    target: string
    effectId: string | null
    derivedBy: string | null
  }> = []
  for (const symbol of candidates) {
    const walkCtx: WalkContext<Node> = { ...extractCtx, symbol }
    const { calls } = walkTypescriptBody(symbol, walkCtx)
    for (const call of calls) {
      const classification = classifyNestCall(call, {
        owner: makeOwner({ id: symbol.id, name: symbol.name, kind: symbol.kind }),
        file: { path, imports },
        language: "ts",
        registry: noopRegistry,
        config: {},
      })
      results.push({
        symbolName: symbol.name,
        target: call.target,
        effectId: classification?.effectId ?? null,
        derivedBy: classification?.derivedBy ?? null,
      })
    }
  }
  return results
}

describe("integration — lang-typescript walkBody → effects-nest classify", () => {
  it("classifies this.eventBus.emit(...) inside a service method as event.publish", async () => {
    const results = await classifyCalls(
      "src/services/orders.service.ts",
      `import { Injectable } from "@nestjs/common"
import { EventEmitter2 } from "@nestjs/event-emitter"
@Injectable()
export class OrdersService {
  constructor(private readonly eventBus: EventEmitter2) {}
  create() {
    this.eventBus.emit("order.created", { id: 1 })
  }
}`,
    )
    const call = results.find((r) => r.target === "this.eventBus.emit")
    expect(call?.effectId).toBe("event.publish")
    expect(call?.derivedBy).toBe("effects-plugin:nest:eventBus.emit")
  })

  it("classifies a top-level eventBus.emit(...) as event.publish", async () => {
    const results = await classifyCalls(
      "src/publish.ts",
      `import { EventEmitter2 } from "@nestjs/event-emitter"
export function publish(eventBus: EventEmitter2) {
  eventBus.emit("thing.happened", 1)
}`,
    )
    const call = results.find((r) => r.target === "eventBus.emit")
    expect(call?.effectId).toBe("event.publish")
  })

  it("returns null for socket.emit(...) even inside a file that also imports @nestjs/event-emitter", async () => {
    // socket.emit is the @nestjs/websockets API — same method name, different meaning.
    // The name-hint gate is what stops this from false-classifying.
    const results = await classifyCalls(
      "src/gateway.ts",
      `import { EventEmitter2 } from "@nestjs/event-emitter"
import { WebSocketGateway } from "@nestjs/websockets"
@WebSocketGateway()
export class Gateway {
  broadcast(socket: any) { socket.emit("update", {}) }
}`,
    )
    const socketCall = results.find((r) => r.target === "socket.emit")
    expect(socketCall?.effectId).toBeNull()
  })

  it("returns null for every call when the file does not import a Nest emitter module", async () => {
    const results = await classifyCalls(
      "src/other.ts",
      `import { EventEmitter } from "events"
export function raiseSomething(bus: EventEmitter) {
  bus.emit("data", 1)
}`,
      [{ source: "events", symbols: ["EventEmitter"], line: 1, dynamic: false }],
    )
    for (const r of results) {
      expect(r.effectId).toBeNull()
    }
  })

  it("emits derivedBy under the shared effects-plugin:nest prefix", async () => {
    const results = await classifyCalls(
      "src/prefix-check.ts",
      `import { EventEmitter2 } from "@nestjs/event-emitter"
export class Publisher {
  constructor(private readonly eventBus: EventEmitter2) {}
  a() { this.eventBus.emit("a", {}) }
  b() { this.eventBus.emit("b", {}) }
}`,
    )
    for (const r of results.filter((r) => r.derivedBy !== null)) {
      expect(r.derivedBy?.startsWith("effects-plugin:nest:")).toBe(true)
    }
  })
})
