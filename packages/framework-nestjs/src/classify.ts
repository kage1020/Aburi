import type {
  ExtractionContext,
  OpaqueAstNode,
  SymbolCandidate,
  SymbolClassification,
} from "@aburi/types"
import {
  classifyClassDecorator,
  isMethodBoundaryDecorator,
  NESTJS_CLASS_DECORATORS,
  NESTJS_HANDLER_DECORATORS,
  NESTJS_HTTP_METHOD_DECORATORS,
  NESTJS_PATTERN_DECORATORS,
} from "./decorators"

/**
 * Route decorator extKind. Reused for HTTP methods and pattern-style handlers alike so
 * downstream tooling can filter every framework-visible entry point with one predicate.
 */
const ROUTE_EXT_KIND = "framework:nestjs:route"

/**
 * Classify a SymbolCandidate emitted by the language plugin.
 *
 * Returns a `SymbolClassification` when at least one NestJS decorator applies, or `null`
 * when nothing matches — matching `null` is important because core runs classifiers with
 * first-match-wins semantics and returning a hollow classification would shadow other
 * plugins that would otherwise fire.
 *
 * Symbol.kind picks the branch: classes look for `@Module` / `@Controller` / `@Injectable`
 * / `@Catch`; methods look for HTTP method decorators plus Guards / Interceptors / Pipes
 * / Filters plus microservice pattern handlers. Nothing else is inspected because the
 * design defers non-decorator NestJS conventions (class name suffixes, folder
 * conventions) to later WIs.
 */
export function classifyNestjsSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  _ctx: ExtractionContext,
): SymbolClassification | null {
  if (symbol.kind === "class") return classifyClass(symbol)
  if (symbol.kind === "method") return classifyMethod(symbol)
  return null
}

/**
 * Class classification is winner-take-all: if @Module / @Controller / @Injectable /
 * @Catch appears, that is the class's role. When more than one class-level decorator is
 * present (e.g. `@Controller @Injectable class MyThing {}`), the first one found in
 * decorator source order wins so results stay stable across re-runs.
 *
 * boundary flags are emitted for every recognized class-level decorator — the framework
 * cares about the shape as a whole, not just the "winning" one, so a `@Controller` that
 * also has `@Injectable` still gets both flagged in decoratorBoundaries.
 */
function classifyClass(symbol: SymbolCandidate<OpaqueAstNode>): SymbolClassification | null {
  const boundaries: Record<string, boolean> = {}
  let winner: { extKind: string; role: string } | null = null

  for (const decorator of symbol.decorators) {
    const hit = classifyClassDecorator(decorator.name)
    if (hit === undefined) continue
    boundaries[decorator.name] = true
    if (winner === null) winner = hit
  }
  if (winner === null) return null

  return {
    extKind: winner.extKind,
    decoratorBoundaries: boundaries,
    derivedBy: `framework:nestjs:${winner.role}`,
  }
}

/**
 * Method classification promotes the method to `framework:nestjs:route` when it carries an
 * HTTP verb decorator or a pattern-style entry point. Handler-only decorators (Guards /
 * Interceptors / Pipes / Filters) mark the enclosing method as a boundary without
 * assigning the route extKind — a service method wrapped in a Guard is still a
 * boundary-worthy check, but it is not the route itself.
 *
 * The design puts the boundary map on `decoratorBoundaries` regardless: framework core
 * flips the SymbolCandidate.decorators[].boundary flags from those keys after this
 * plugin returns, keeping the plugin idempotent.
 */
function classifyMethod(symbol: SymbolCandidate<OpaqueAstNode>): SymbolClassification | null {
  const boundaries: Record<string, boolean> = {}
  let route: string | null = null
  let handler: string | null = null

  for (const decorator of symbol.decorators) {
    if (!isMethodBoundaryDecorator(decorator.name)) continue
    boundaries[decorator.name] = true
    if (
      NESTJS_HTTP_METHOD_DECORATORS.has(decorator.name) ||
      NESTJS_PATTERN_DECORATORS.has(decorator.name)
    ) {
      if (route === null) route = decorator.name
      continue
    }
    if (handler === null) handler = decorator.name
  }
  if (route === null && handler === null) return null

  // derivedBy carries the original decorator identifier verbatim on both branches so a
  // grep from `framework:nestjs:route:Post` lands on the source `@Post()` decorator
  // without a case-transform round-trip. The class branch mirrors the same policy via a
  // normalized `role` field on the vocabulary table.
  if (route !== null) {
    return {
      extKind: ROUTE_EXT_KIND,
      decoratorBoundaries: boundaries,
      derivedBy: `framework:nestjs:route:${route}`,
    }
  }
  // Handler-only branch: `handler` is guaranteed non-null here — the earlier `route ===
  // null && handler === null` guard is the single source of nullability truth, and the
  // TS control-flow narrowing carries that guarantee through the assertion below.
  if (handler === null) throw new Error("unreachable: guarded above")
  return {
    decoratorBoundaries: boundaries,
    derivedBy: `framework:nestjs:handler:${handler}`,
  }
}

// Re-export the decorator inspection surface symmetrically for classes and methods so a
// consumer that wants to introspect either side does not have to import from a sub-path.
export {
  classifyClassDecorator,
  isMethodBoundaryDecorator,
  NESTJS_CLASS_DECORATORS,
  NESTJS_HANDLER_DECORATORS,
  NESTJS_HTTP_METHOD_DECORATORS,
  NESTJS_PATTERN_DECORATORS,
}
