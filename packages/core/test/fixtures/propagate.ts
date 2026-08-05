import type { Effect } from "@aburi/types"
import type { CallEdge } from "../../src/callgraph"

/**
 * Builders shared by the effect-propagation tests. They lived in `propagate.test.ts` with
 * one signature and in `propagate-order.test.ts` with another, which made the two files
 * read as though they were testing different things.
 */

/** A locally-detected Effect: `line` present, `propagated` absent (ir-schema.md §9). */
export function effect(id: string, target: string, overrides: Partial<Effect> = {}): Effect {
  return {
    id,
    target,
    line: overrides.line ?? 1,
    plugin: overrides.plugin ?? "effects-test",
    confidence: overrides.confidence ?? "high",
    derivedBy: overrides.derivedBy ?? `effects-plugin:test:${id}`,
  }
}

export function edge(from: string, to: string, overrides: Partial<CallEdge> = {}): CallEdge {
  return {
    from: from as CallEdge["from"],
    to: to as CallEdge["to"],
    via: "call",
    confidence: overrides.confidence ?? "high",
    line: overrides.line ?? 1,
  }
}
