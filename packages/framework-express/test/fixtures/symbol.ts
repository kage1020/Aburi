import type {
  Config,
  ExtractionContext,
  SourceFile,
  SymbolCandidate,
  SymbolKind,
  VocabRegistry,
} from "@aburi/types"

const noopRegistry: VocabRegistry = {
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

const emptyConfig: Config = {}

export function makeCtx(path = "src/a.ts", content = ""): ExtractionContext {
  const file: SourceFile = { path, content }
  return { file, registry: noopRegistry, config: emptyConfig }
}

export function makeCandidate(
  overrides: Partial<SymbolCandidate<unknown>> & { kind: SymbolKind },
): SymbolCandidate<unknown> {
  const filePath = overrides.source?.file ?? "src/a.ts"
  return {
    id: overrides.id ?? `ts:${filePath}#${overrides.name ?? "Placeholder"}`,
    kind: overrides.kind,
    extKind: overrides.extKind ?? null,
    name: overrides.name ?? "Placeholder",
    visibility: overrides.visibility ?? "internal",
    decorators: overrides.decorators ?? [],
    signature: overrides.signature ?? null,
    source: overrides.source ?? {
      file: filePath,
      startLine: 1,
      endLine: 1,
      startColumn: null,
      endColumn: null,
    },
    derivedBy: overrides.derivedBy ?? [],
    bodyNode: overrides.bodyNode ?? null,
    fullNode: overrides.fullNode ?? { placeholder: true },
  }
}
