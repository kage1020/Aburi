import { importEdge } from "@aburi/test-support"
import type { ImportEdge } from "@aburi/types"

export function makeNestEmitterImport(): ImportEdge {
  return importEdge({ source: "@nestjs/event-emitter", symbols: ["EventEmitter2"] })
}

export function makeEventemitter2Import(): ImportEdge {
  return importEdge({ source: "eventemitter2", symbols: ["EventEmitter2"] })
}
