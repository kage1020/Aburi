import type {
  Config,
  ExtractionContext,
  SourceFile,
  SymbolCandidate,
  SymbolId,
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
  // `id` is widened back to `string` so cases keep writing literals; the branding happens
  // here, once.
  overrides: Omit<Partial<SymbolCandidate<unknown>>, "id"> & { kind: SymbolKind; id?: string },
): SymbolCandidate<unknown> {
  const filePath = overrides.source?.file ?? "src/a.ts"
  return {
    id: symbolId(overrides.id ?? `ts:${filePath}#${overrides.name ?? "Placeholder"}`),
    kind: overrides.kind,
    extKind: overrides.extKind ?? null,
    name: overrides.name ?? "Placeholder",
    visibility: overrides.visibility ?? "public",
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

/**
 * Brand a literal as a Symbol id. Fixtures are a documented boundary layer where an id is
 * asserted rather than constructed (ir-schema.md §3.5); production code reaches a `SymbolId`
 * only through `makeSymbolId` / `trySymbolId` in `@aburi/core`, which check the grammar.
 */
function symbolId(raw: string): SymbolId {
  return raw as SymbolId
}
