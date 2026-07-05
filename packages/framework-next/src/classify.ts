import { lastQnameSegment } from "@aburi/core"
import type {
  ExtractionContext,
  OpaqueAstNode,
  SymbolCandidate,
  SymbolClassification,
} from "@aburi/types"
import { type AppRouterFile, recognizeAppRouterFile } from "./app-router"
import { detectModuleDirective, type ModuleDirective } from "./directives"

/**
 * Every HTTP verb the App Router recognizes as a named export inside `route.{ts,js}`.
 * A verb export becomes a `framework:next:route` Symbol; consumers can inspect the set
 * directly (via the public re-export from `./index`) if they need to detect route
 * handlers themselves.
 *
 * Literal union so `Set.has(x)` narrows `x` to the union inside a truthy branch, and
 * template-literal types over `derivedBy` inherit the same literal precision downstream.
 */
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

/**
 * Type guard: true when `name` is one of the seven recognized HTTP verbs. Emits the
 * narrowed literal type so downstream template-literal builders (`derivedBy` etc.)
 * inherit the precision.
 */
export function isNextHttpVerb(name: string): name is NextHttpVerb {
  return (NEXT_ROUTE_HTTP_VERBS as ReadonlySet<string>).has(name)
}

/**
 * Classify a SymbolCandidate emitted by the language plugin against the Next.js App
 * Router conventions.
 *
 * Recognition is a two-axis join:
 *   - `Symbol.source.file` identifies whether this file is a special App Router file
 *     (see `app-router.ts`). Non-app-router files return `null`.
 *   - `ctx.file.content` is scanned for a top-of-module `"use client"` / `"use server"`
 *     directive when the file IS an app-router file. The directive result is added to
 *     `derivedBy` so consumers can distinguish server components from client components
 *     even when the extKind alone would look identical.
 *
 * Non-app-router files can still carry `"use client"` / `"use server"` directives — a
 * colocated component under `app/` for example — but this classifier only annotates them
 * when the enclosing Symbol is already an App Router special file. Broader server-action
 * detection across arbitrary files is out of the current recognizer's scope.
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

/**
 * `app/**\/route.ts` — a route file exports HTTP verb handlers by name. Each named verb
 * export becomes a `framework:next:route` Symbol with its boundary flag flipped so
 * downstream diff / rendering treats it as an entry point.
 *
 * Anything else in the same file (helpers, module-level side effects, non-verb named
 * exports) returns `null` and flows through unclassified.
 */
function classifyRouteSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  ctx: ExtractionContext,
): SymbolClassification | null {
  if (symbol.kind !== "function") return null
  // `lastQnameSegment` throws on a broken qname, which is the right behavior — a route
  // handler with a malformed name is a language-plugin bug we do not want to swallow.
  const leaf = lastQnameSegment(symbol.name)
  if (!isNextHttpVerb(leaf)) return null
  return withDirective(
    {
      extKind: "framework:next:route",
      derivedBy: `framework:next:route:${leaf}`,
    },
    ctx,
  )
}

/**
 * `app/**\/{page,layout,template,loading,error,not-found}.tsx` — the default export
 * function is the framework-visible Symbol.
 *
 * The language plugin surfaces `<default>` for genuinely anonymous default exports and
 * carries `"export-default"` on `derivedBy` for both anonymous AND named-but-default
 * shapes (`export default function Page() {}`). Checking `derivedBy` catches both.
 * Non-default helper exports in the same file are skipped because they never carry the
 * `"export-default"` marker.
 */
function classifyComponentSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  file: AppRouterFile,
  ctx: ExtractionContext,
): SymbolClassification | null {
  if (symbol.kind !== "function") return null
  if (!isDefaultExportSymbol(symbol)) return null
  return withDirective(
    {
      extKind: `framework:next:${file.role}`,
      derivedBy: `framework:next:${file.role}`,
    },
    ctx,
  )
}

/**
 * Fold the module-level `"use client"` / `"use server"` directive into the
 * classification's `derivedBy` string when the file carries one. The extKind stays the
 * App Router role because the framework treats page / layout / route identity
 * independently of client-vs-server rendering — the directive is metadata, not a
 * different extKind.
 *
 * derivedBy is a single string on the SymbolClassification, so directive information is
 * appended after a `;` delimiter when present. Consumers that split on `;` recover both
 * signals; consumers that only need the role can still substring-match on the leading
 * `framework:next:*` prefix.
 */
function withDirective(base: SymbolClassification, ctx: ExtractionContext): SymbolClassification {
  const directive = detectModuleDirective(ctx.file.content)
  if (directive === null) return base
  return {
    ...base,
    derivedBy: `${base.derivedBy};framework:next:${directiveTag(directive)}`,
  }
}

type DirectiveTag = "client-component" | "server-action"

function directiveTag(directive: ModuleDirective): DirectiveTag {
  return directive === "client" ? "client-component" : "server-action"
}

/**
 * True when the SymbolCandidate came from an `export default` declaration — including
 * both the anonymous form (name = `<default>`) and the named form
 * (`export default function Page()` whose language-plugin-emitted name is `Page` but
 * whose `derivedBy` carries `"export-default"`).
 */
function isDefaultExportSymbol(symbol: SymbolCandidate<OpaqueAstNode>): boolean {
  return symbol.derivedBy.includes("export-default")
}
