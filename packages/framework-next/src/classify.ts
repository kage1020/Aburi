import type {
  ExtractionContext,
  OpaqueAstNode,
  SymbolCandidate,
  SymbolClassification,
  SymbolKind,
} from "@aburi/types"
import { type AppRouterFile, recognizeAppRouterFile } from "./app-router"
import { detectModuleDirective, type ModuleDirective } from "./directives"
import { NEXT_DERIVED_BY_PREFIX } from "./manifest"

export type NextHttpVerb = "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "OPTIONS" | "HEAD"

export const NEXT_ROUTE_HTTP_VERBS: ReadonlySet<NextHttpVerb> = new Set<NextHttpVerb>([
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "OPTIONS",
  "HEAD",
])

export function isNextHttpVerb(name: string): name is NextHttpVerb {
  return (NEXT_ROUTE_HTTP_VERBS as ReadonlySet<string>).has(name)
}
export function classifyNextSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  ctx: ExtractionContext,
): SymbolClassification | null {
  const file = recognizeAppRouterFile(symbol.source.file)
  if (file === null) return null

  if (file.role === "route") return classifyRouteSymbol(symbol, ctx)
  return classifyComponentSymbol(symbol, file, ctx)
}

/** Next calls the handler either way; a `const` is one whose value the language plugin cannot see into. */
const ROUTE_HANDLER_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>(["function", "const"])

const EXPORT_CLAUSE_PREFIX = "export-clause:"

function classifyRouteSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  ctx: ExtractionContext,
): SymbolClassification | null {
  if (!ROUTE_HANDLER_KINDS.has(symbol.kind)) return null
  const verbs = exportedNames(symbol).filter(isNextHttpVerb)
  if (verbs.length === 0) return null
  return withDirective(
    {
      extKind: "framework:next:route",
      derivedBy: verbs.map((verb) => `${NEXT_DERIVED_BY_PREFIX}:route:${verb}`).join(";"),
    },
    ctx,
  )
}

/** The keyword exports a declaration under its whole qname, so a namespace's `N.GET` is no module export. */
function exportedNames(symbol: SymbolCandidate<OpaqueAstNode>): string[] {
  const names = new Set<string>()
  if (symbol.derivedBy.includes("export-keyword")) names.add(symbol.name)
  for (const token of symbol.derivedBy) {
    if (token.startsWith(EXPORT_CLAUSE_PREFIX)) names.add(token.slice(EXPORT_CLAUSE_PREFIX.length))
  }
  return [...names]
}

function classifyComponentSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  file: AppRouterFile,
  ctx: ExtractionContext,
): SymbolClassification | null {
  if (symbol.kind !== "function") return null
  if (!symbol.derivedBy.includes("export-default")) return null
  return withDirective(
    {
      extKind: `framework:next:${file.role}`,
      derivedBy: `${NEXT_DERIVED_BY_PREFIX}:${file.role}`,
    },
    ctx,
  )
}

function withDirective(base: SymbolClassification, ctx: ExtractionContext): SymbolClassification {
  const directive = detectModuleDirective(ctx.file.content)
  if (directive === null) return base
  return {
    ...base,
    derivedBy: `${base.derivedBy};${NEXT_DERIVED_BY_PREFIX}:${directiveTag(directive)}`,
  }
}

type DirectiveTag = "client-component" | "server-action"

function directiveTag(directive: ModuleDirective): DirectiveTag {
  return directive === "client" ? "client-component" : "server-action"
}
