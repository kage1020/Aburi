import type {
  Config,
  Decorator,
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
  return {
    id: overrides.id ?? "ts:src/a.ts#Placeholder",
    kind: overrides.kind,
    extKind: overrides.extKind ?? null,
    name: overrides.name ?? "Placeholder",
    visibility: overrides.visibility ?? "public",
    decorators: overrides.decorators ?? [],
    signature: overrides.signature ?? null,
    source: overrides.source ?? {
      file: "src/a.ts",
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

export function makeDecorator(name: string, args: string[] = [], line = 1): Decorator {
  const argList = args.join(", ")
  return {
    name,
    raw: args.length > 0 ? `${name}(${argList})` : name,
    arguments: args,
    boundary: false,
    line,
  }
}
