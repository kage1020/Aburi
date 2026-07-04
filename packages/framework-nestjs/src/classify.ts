import { CoreError } from "@aburi/core"
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
 * when nothing matches — returning `null` is important because the framework pipeline
 * runs classifiers with first-match-wins semantics and a hollow classification would
 * shadow other plugins that would otherwise fire.
 *
 * Symbol.kind picks the branch: classes look for `@Module` / `@Controller` /
 * `@Injectable` / `@Catch`; methods look for HTTP method decorators plus Guards /
 * Interceptors / Pipes / Filters plus microservice pattern handlers. Non-decorator NestJS
 * conventions (class-name suffixes, folder conventions) are out of scope — they would
 * belong to a separate classifier if we ever add one.
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
 * Class classification is winner-take-all: if `@Module` / `@Controller` / `@Injectable`
 * / `@Catch` appears, that is the class's role. When more than one class-level decorator
 * is present (e.g. `@Controller @Injectable class MyThing {}`), the first one found in
 * decorator source order wins so results stay stable across re-runs.
 *
 * `decoratorBoundaries` gets a `true` entry for every recognized class-level decorator —
 * the framework cares about the shape as a whole, not just the "winning" one, so a
 * `@Controller` that also has `@Injectable` still surfaces both in the map.
 */
function classifyClass(symbol: SymbolCandidate<OpaqueAstNode>): SymbolClassification | null {
  const boundaries: Record<string, true> = {}
  let winner: { extKind: string; role: string } | null = null

  for (const decorator of symbol.decorators) {
    assertDecoratorName(decorator.name, symbol.id)
    const hit = classifyClassDecorator(decorator.name)
    if (hit === undefined) continue
    boundaries[decorator.name] = true
    if (winner === null) winner = hit
  }
  if (winner === null) return null

  return {
    extKind: winner.extKind,
    decoratorBoundaries: boundaries,
    // Class derivedBy uses the semantic `role` (module / controller / provider / filter)
    // rather than the source decorator identifier because NestJS renames the concept —
    // `@Injectable` semantically means "provider", and the derivedBy string carries that
    // meaning. Method derivedBy preserves the source decorator identifier verbatim (see
    // classifyMethod) because HTTP verbs and handler names have no equivalent semantic
    // rewrite; the source name IS the meaning.
    derivedBy: `framework:nestjs:${winner.role}`,
  }
}

/**
 * Method classification promotes the method to `framework:nestjs:route` when it carries
 * an HTTP verb decorator or a pattern-style entry point. Handler-only decorators
 * (Guards / Interceptors / Pipes / Filters) mark the enclosing method as a boundary
 * without assigning the route extKind — a service method wrapped in a Guard is still a
 * boundary-worthy check, but it is not the route itself.
 *
 * `derivedBy` preserves the source decorator identifier verbatim (`Post`, `UseGuards`,
 * `MessagePattern`, …) so a grep from the emitted string lands directly on the source
 * decorator in the `.ts` file. Class classification uses a semantic role name instead;
 * the asymmetry is deliberate (see classifyClass).
 */
function classifyMethod(symbol: SymbolCandidate<OpaqueAstNode>): SymbolClassification | null {
  const boundaries: Record<string, true> = {}
  let firstRoute: string | null = null
  let firstHandler: string | null = null

  for (const decorator of symbol.decorators) {
    const name = decorator.name
    assertDecoratorName(name, symbol.id)
    if (!isMethodBoundaryDecorator(name)) continue
    boundaries[name] = true
    if (NESTJS_HTTP_METHOD_DECORATORS.has(name) || NESTJS_PATTERN_DECORATORS.has(name)) {
      firstRoute ??= name
    } else {
      firstHandler ??= name
    }
  }

  if (firstRoute !== null) {
    return {
      extKind: ROUTE_EXT_KIND,
      decoratorBoundaries: boundaries,
      derivedBy: `framework:nestjs:route:${firstRoute}`,
    }
  }
  if (firstHandler !== null) {
    return {
      decoratorBoundaries: boundaries,
      derivedBy: `framework:nestjs:handler:${firstHandler}`,
    }
  }
  return null
}

/**
 * Refuse to silently skip a decorator with an empty name. The upstream language plugin
 * normally guarantees non-empty identifiers, but a grammar regression could produce an
 * empty string that would then flow through `Set.has("")` / `Map.get("")` without
 * matching anything and disappear — losing the signal that the grammar produced
 * something unexpected. Match the fail-fast contract used by the language plugin's own
 * name-required helpers.
 */
function assertDecoratorName(name: string, symbolId: string): void {
  if (name.length > 0) return
  throw new CoreError(
    `Empty decorator name on Symbol "${symbolId}"; the upstream language plugin produced an unexpected grammar shape and this classifier refuses to silently skip it`,
    { code: "anonymous-symbol-id-attempted", value: symbolId },
  )
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
