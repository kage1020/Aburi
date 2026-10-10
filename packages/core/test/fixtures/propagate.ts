import { effect, symbolId } from "@aburi/test-support"
import type { Confidence, Effect } from "@aburi/types"
import type { CallEdge } from "../../src/callgraph"

export function localEffect(
  overrides: Omit<Partial<Effect>, "propagated" | "derivedFrom"> & { id: string; target: string },
): Effect {
  return effect({ plugin: "effects-test", ...overrides })
}

export function edge(
  from: string,
  to: string,
  overrides: { confidence?: Confidence; line?: number } = {},
): CallEdge {
  return {
    from: symbolId(from),
    to: symbolId(to),
    via: "call",
    confidence: overrides.confidence ?? "high",
    line: overrides.line ?? 1,
  }
}
