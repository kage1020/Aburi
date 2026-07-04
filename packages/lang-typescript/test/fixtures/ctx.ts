import type { Config, ExtractionContext, SourceFile, VocabRegistry } from "@aburi/types"
import type { Tree } from "web-tree-sitter"

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

/**
 * Narrow a nullable Tree for tests that only exercise the happy path. Fails loudly when
 * the parse returned null so the missing tree does not get silently masked as an empty
 * Symbol list.
 */
export function requireTree(tree: Tree | null): Tree {
  if (tree === null) throw new Error("test fixture invariant: parse returned null")
  return tree
}
