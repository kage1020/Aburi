import type { ImportEdge } from "@aburi/types"

export function makeNestEmitterImport(): ImportEdge {
  return {
    source: "@nestjs/event-emitter",
    symbols: ["EventEmitter2"],
    line: 1,
    dynamic: false,
  }
}

export function makeEventemitter2Import(): ImportEdge {
  return { source: "eventemitter2", symbols: ["EventEmitter2"], line: 1, dynamic: false }
}
