// Builders for the values an effects plugin classifies: CallCandidate, OwnerSummary,
// ClassifyContext. Every field carries a contract-satisfying default so cases only spell
// out what they intend to change.
import type { CallCandidate, ClassifyContext, ImportEdge, OwnerSummary } from "@aburi/types"
import { symbolId } from "./ir"
import { noopRegistry } from "./registry"

export function makeCall(
  overrides: Partial<CallCandidate> & Pick<CallCandidate, "target">,
): CallCandidate {
  return {
    line: 1,
    argumentCount: 0,
    inAwait: false,
    inNew: false,
    literalArgs: [],
    ...overrides,
  }
}

export function makeOwner(overrides: Partial<OwnerSummary> = {}): OwnerSummary {
  return {
    id: symbolId("ts:test.ts#Owner"),
    kind: "function",
    name: "Owner",
    extKind: null,
    decorators: [],
    component: null,
    ...overrides,
  }
}

export function makeCtx({
  imports = [],
  path = "src/service.ts",
  owner = makeOwner(),
  language = "ts",
}: {
  imports?: ImportEdge[]
  path?: string
  owner?: OwnerSummary
  language?: string
} = {}): ClassifyContext {
  return {
    owner,
    file: { path, imports },
    language,
    registry: noopRegistry,
    config: {},
  }
}
