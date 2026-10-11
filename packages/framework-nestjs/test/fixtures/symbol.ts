import { decorator, importEdge, makeCandidate, makeExtractionCtx } from "@aburi/test-support"
import type {
  Decorator,
  FrameworkClassifyContext,
  ImportEdge,
  SymbolClassification,
  SymbolKind,
} from "@aburi/types"
import { classifyNestjsSymbol } from "../../src/index"

export const NEST = "@nestjs/common"

export function makeImport(source: string, symbols: string[] | "*", line = 1): ImportEdge {
  return importEdge({ source, symbols, line })
}

export function makeNamespaceImport(source: string, binding: string, line = 1): ImportEdge {
  return { ...makeImport(source, "*", line), namespaceBinding: binding }
}

export function makeCtx({
  path = "src/a.ts",
  imports = [],
}: {
  path?: string
  imports?: readonly ImportEdge[]
} = {}): FrameworkClassifyContext {
  return { ...makeExtractionCtx(path, ""), imports }
}

/** A bare name stands for that decorator written unqualified, in list order. */
export function classifyDecorated(
  kind: SymbolKind,
  decorators: readonly (string | Decorator)[],
  imports: readonly ImportEdge[] = [],
): SymbolClassification | null {
  const written = decorators.map((d, i) =>
    typeof d === "string" ? decorator({ name: d, line: i + 1 }) : d,
  )
  return classifyNestjsSymbol(
    makeCandidate({ kind, name: kind === "method" ? "C.m" : "C", decorators: written }),
    makeCtx({ imports }),
  )
}
