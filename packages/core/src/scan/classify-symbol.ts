import type {
  Confidence,
  Decorator,
  DropHint,
  ExtKind,
  FrameworkClassifyContext,
  FrameworkPlugin,
  LanguagePlugin,
  OpaqueAstNode,
  SymbolCandidate,
  SymbolClassification,
} from "@aburi/types"
import { toNfc } from "../codepoints"
import { decideSymbolDrop } from "./drop-b"

export interface FrameworkMergeResult {
  candidate: SymbolCandidate<OpaqueAstNode>
  confidence: Confidence
  extKindBy: string | null
  middleware: string[]
}

function decoratorBoundaryKey(decorator: Decorator): string {
  const { qualifier } = decorator
  return qualifier === undefined ? decorator.name : `${qualifier}.${decorator.name}`
}

export function mergeFrameworkClassification(
  candidate: SymbolCandidate<OpaqueAstNode>,
  frameworks: readonly FrameworkPlugin[],
  ctx: FrameworkClassifyContext,
  languagePlugin: string,
): FrameworkMergeResult {
  const extractedBy = candidate.extKind === null ? null : languagePlugin
  for (const framework of frameworks) {
    const result = framework.classifySymbol(candidate, ctx) as SymbolClassification | null
    if (result === null) continue
    const decorators = candidate.decorators.map((d) => {
      const override = result.decoratorBoundaries?.[decoratorBoundaryKey(d)]
      return override === undefined ? d : { ...d, boundary: override }
    })
    return {
      candidate: {
        ...candidate,
        extKind: (result.extKind ?? candidate.extKind) as ExtKind,
        decorators,
        derivedBy: mergeDerivedBy(candidate.derivedBy, result.derivedBy),
      },
      confidence: result.confidence ?? "high",
      extKindBy:
        result.extKind === undefined || result.extKind === null
          ? extractedBy
          : framework.manifest.name,
      middleware: (result.middleware ?? []).filter((name) => name.length > 0).map(toNfc),
    }
  }
  return { candidate, confidence: "high", extKindBy: extractedBy, middleware: [] }
}

function mergeDerivedBy(current: readonly string[], addition: string): string[] {
  const parts = addition.split(";").filter((s) => s.length > 0)
  const merged = [...current]
  for (const p of parts) if (!merged.includes(p)) merged.push(p)
  return merged
}

export function decideDropReason(
  candidate: SymbolCandidate<OpaqueAstNode>,
  language: LanguagePlugin,
  frameworks: readonly FrameworkPlugin[],
  ctx: FrameworkClassifyContext,
): string | null {
  const core = decideSymbolDrop(candidate)
  if (core !== null) return core
  for (const framework of frameworks) {
    const hint: DropHint | null = framework.symbolDropHint?.(candidate, ctx) ?? null
    if (hint !== null) return hint.reason
  }
  const hint: DropHint | null = language.symbolDropHint?.(candidate, ctx) ?? null
  return hint?.reason ?? null
}
