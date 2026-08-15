import type {
  Config,
  Decorator,
  FrameworkClassifyContext,
  ImportEdge,
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

export interface CtxOverrides {
  path?: string
  content?: string
  imports?: ImportEdge[]
}

export function makeCtx(overrides: CtxOverrides = {}): FrameworkClassifyContext {
  const file: SourceFile = { path: overrides.path ?? "src/a.ts", content: overrides.content ?? "" }
  return {
    file,
    registry: noopRegistry,
    config: emptyConfig,
    imports: overrides.imports ?? [],
  }
}

/**
 * A static named-import edge, the shape `@aburi/lang-typescript` emits. `symbols` entries
 * follow the `ImportEdge.symbols` wire format, so an aliased import is written the way the
 * source wrote it: `"Controller as Ctrl"`.
 */
export function makeImport(source: string, symbols: string[] | "*", line = 1): ImportEdge {
  return { source, symbols, line, dynamic: false }
}

export function makeCandidate(
  // `id` is widened back to `string` so cases keep writing literals; the branding happens
  // here, once.
  overrides: Omit<Partial<SymbolCandidate<unknown>>, "id"> & { kind: SymbolKind; id?: string },
): SymbolCandidate<unknown> {
  return {
    id: symbolId(overrides.id ?? "ts:src/a.ts#Placeholder"),
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

/**
 * Brand a literal as a Symbol id. Fixtures are a documented boundary layer where an id is
 * asserted rather than constructed (ir-schema.md §3.5); production code reaches a `SymbolId`
 * only through `makeSymbolId` / `trySymbolId` in `@aburi/core`, which check the grammar.
 */
function symbolId(raw: string): SymbolId {
  return raw as SymbolId
}
