import type {
  ExtractionContext,
  SymbolCandidate,
  SymbolId,
  SymbolKind,
  Visibility,
} from "@aburi/types"
import { noopRegistry } from "./registry"

/** An `ExtractionContext` over one in-memory file, backed by `noopRegistry`. */
export function makeExtractionCtx(path = "src/a.ts", content = ""): ExtractionContext {
  return { file: { path, content }, registry: noopRegistry, config: {} }
}

/** `id` is widened back to `string` so cases keep writing literals; the branding happens in `makeCandidate`, once. */
export type CandidateOverrides = Omit<Partial<SymbolCandidate<unknown>>, "id"> & {
  kind: SymbolKind
  id?: string
}

/** Per-suite defaults for the fields the framework fixtures disagreed on. */
export interface CandidateDefaults {
  visibility?: Visibility
  /** Default `source.file`, also the file half of the generated id. */
  filePath?: string
}

export function makeCandidate(
  overrides: CandidateOverrides,
  defaults: CandidateDefaults = {},
): SymbolCandidate<unknown> {
  const filePath = overrides.source?.file ?? defaults.filePath ?? "src/a.ts"
  const name = overrides.name ?? "Placeholder"
  return {
    id: symbolId(overrides.id ?? `ts:${filePath}#${name}`),
    kind: overrides.kind,
    extKind: overrides.extKind ?? null,
    name,
    visibility: overrides.visibility ?? defaults.visibility ?? "public",
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
 * Fixtures are a documented boundary layer where an id is asserted rather than constructed
 * (ir-schema.md); production code reaches a `SymbolId` only through `makeSymbolId` /
 * `trySymbolId` in `@aburi/core`.
 */
function symbolId(raw: string): SymbolId {
  return raw as SymbolId
}
