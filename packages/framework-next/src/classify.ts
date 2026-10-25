import {
  CALL_ARGUMENT_FUNCTION_DERIVED_BY,
  EXPORT_CLAUSE_DERIVED_BY_PREFIX,
  EXPORT_DEFAULT_DERIVED_BY,
  EXPORT_KEYWORD_DERIVED_BY,
  type ExtractionContext,
  type OpaqueAstNode,
  type SymbolCandidate,
  type SymbolClassification,
  type SymbolKind,
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

/** A handler the language plugin cannot see to be a function (a destructuring, a call's result) is a `const`; Next calls it all the same. */
const ROUTE_HANDLER_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>(["function", "const"])

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

/** `export-keyword` on a namespace member exports it from the namespace, not the module; matching the whole qname keeps `N.GET` from reading as a verb. */
function exportedNames(symbol: SymbolCandidate<OpaqueAstNode>): string[] {
  const names = new Set<string>()
  if (symbol.derivedBy.includes(EXPORT_KEYWORD_DERIVED_BY)) names.add(symbol.name)
  for (const token of symbol.derivedBy) {
    if (token.startsWith(EXPORT_CLAUSE_DERIVED_BY_PREFIX)) {
      names.add(token.slice(EXPORT_CLAUSE_DERIVED_BY_PREFIX.length))
    }
  }
  return [...names]
}

function classifyComponentSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  file: AppRouterFile,
  ctx: ExtractionContext,
): SymbolClassification | null {
  if (!isComponentValue(symbol)) return null
  if (!symbol.derivedBy.includes(EXPORT_DEFAULT_DERIVED_BY)) return null
  return withDirective(
    {
      extKind: `framework:next:${file.role}`,
      derivedBy: `${NEXT_DERIVED_BY_PREFIX}:${file.role}`,
    },
    ctx,
  )
}

/** `withAuth(function Page() {…})` is a `const` the language plugin cannot see to be a function; the function it is handed is the evidence. */
function isComponentValue(symbol: SymbolCandidate<OpaqueAstNode>): boolean {
  if (symbol.kind === "function") return true
  return symbol.kind === "const" && symbol.derivedBy.includes(CALL_ARGUMENT_FUNCTION_DERIVED_BY)
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
