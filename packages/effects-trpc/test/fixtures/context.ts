import type {
  CallCandidate,
  ClassifyContext,
  ImportEdge,
  OwnerSummary,
  VocabRegistry,
} from "@aburi/types"

/**
 * A no-op VocabRegistry sufficient to satisfy `ClassifyContext.registry`. The tRPC
 * classifier never touches the registry — its recognition is entirely file-import +
 * target-string driven — so returning `null` / `false` / `[]` for every hook keeps the
 * fixture minimal without hiding a real dependency.
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
  path = "src/client.ts",
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

/** Vanilla client import — the most common client-side gate signal. */
export function makeTrpcClientImport(source = "@trpc/client"): ImportEdge {
  return { source, symbols: ["createTRPCClient"], line: 1, dynamic: false }
}

/** Router-side import — flips the server gate, suppressing the `query` terminal. */
export function makeTrpcServerImport(source = "@trpc/server"): ImportEdge {
  return { source, symbols: ["initTRPC"], line: 1, dynamic: false }
}
