import type { Config, ExtractionContext, SourceFile, VocabRegistry } from "@aburi/types"

/** Minimal stub registry — extraction does not touch these; supply enough shape to satisfy the type. */
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

export function makeExtractionCtx(path: string, content: string): ExtractionContext {
  const file: SourceFile = { path, content }
  return { file, registry: noopRegistry, config: emptyConfig }
}
