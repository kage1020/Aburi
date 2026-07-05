import type {
  CallCandidate,
  ClassifyContext,
  ImportEdge,
  OwnerSummary,
  VocabRegistry,
} from "@aburi/types"

/**
 * A no-op VocabRegistry sufficient to satisfy `ClassifyContext.registry`. The Nest
 * classifier never touches the registry — its recognition is entirely file-import +
 * target-string driven — so returning `null` / `false` / `[]` keeps the fixture minimal.
 */
export const noopRegistry: VocabRegistry = {
  findEffect: () => null,
  findExtKind: () => null,
  findFramework: () => null,
  findDerivedByOwner: () => null,
  isEffectOwnedBy: () => false,
  isExtKindOwnedBy: () => false,
  listEffects: () => [],
  listExtKinds: () => [],
  listFrameworks: () => [],
  listPlugins: () => [],
  assertEffectDeclared: () => {},
  assertExtKindDeclared: () => {},
}

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
    id: "ts:test.ts#Owner",
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
