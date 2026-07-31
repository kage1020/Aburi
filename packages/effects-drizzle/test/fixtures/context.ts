import type {
  CallCandidate,
  ClassifyContext,
  ImportEdge,
  OwnerSummary,
  SymbolId,
  VocabRegistry,
} from "@aburi/types"

/**
 * A no-op VocabRegistry sufficient to satisfy `ClassifyContext.registry`. The Drizzle
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

export function makeDrizzleImport(source = "drizzle-orm"): ImportEdge {
  return { source, symbols: ["sql"], line: 1, dynamic: false }
}

/**
 * Brand a literal as a Symbol id. Fixtures are a documented boundary layer where an id is
 * asserted rather than constructed (ir-schema.md §3.5); production code reaches a `SymbolId`
 * only through `makeSymbolId` / `trySymbolId` in `@aburi/core`, which check the grammar.
 */
function symbolId(raw: string): SymbolId {
  return raw as SymbolId
}
