import { lastQnameSegment } from "@aburi/core"
import type {
  ExtractionContext,
  OpaqueAstNode,
  SymbolCandidate,
  SymbolClassification,
} from "@aburi/types"
import { type AppRouterFile, recognizeAppRouterFile } from "./app-router"
import { detectModuleDirective, type ModuleDirective } from "./directives"
import { NEXT_DERIVED_BY_PREFIX } from "./manifest"

/** HTTP verbs the App Router accepts as named exports of `route.{ts,js}`. */
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

/**
 * Two-axis join: `symbol.source.file` decides whether this is an App Router special file
 * (else `null`), and the module's `"use client"` / `"use server"` directive is folded into
 * `derivedBy`. Directives in non-special files are out of scope.
 */
export function classifyNextSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  ctx: ExtractionContext,
): SymbolClassification | null {
  const file = recognizeAppRouterFile(symbol.source.file)
  if (file === null) return null

  if (file.role === "route") return classifyRouteSymbol(symbol, ctx)
  return classifyComponentSymbol(symbol, file, ctx)
}

/** `app/**\/route.ts`: each named HTTP verb export is a route; anything else is `null`. */
function classifyRouteSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  ctx: ExtractionContext,
): SymbolClassification | null {
  if (symbol.kind !== "function") return null
  // `lastQnameSegment` throws on a broken qname; that is a language-plugin bug not to swallow.
  const leaf = lastQnameSegment(symbol.name)
  if (!isNextHttpVerb(leaf)) return null
  return withDirective(
    { extKind: "framework:next:route", derivedBy: `${NEXT_DERIVED_BY_PREFIX}:route:${leaf}` },
    ctx,
  )
}

/**
 * `app/**\/{page,layout,…}.tsx`: the default-export function is the framework-visible
 * Symbol. The language plugin marks both anonymous and named default exports with
 * `"export-default"` on `derivedBy`, so that marker is the test.
 */
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

/**
 * Append the module directive after a `;`. The extKind stays the App Router role: client
 * vs server rendering is metadata, not a different kind.
 */
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
