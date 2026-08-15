import { CoreError } from "@aburi/core"
import type {
  Confidence,
  FrameworkClassifyContext,
  ImportEdge,
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
import { type ImportedNames, readImportedNames, resolveDecoratorName } from "./imports"

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
 *
 * The tables are matched against the name a decorator's binding was **imported** under, not
 * the one the source wrote, so `import { Controller as Ctrl }` still resolves (see
 * `./imports`). The index over those edges is read only when there is a decorator to
 * resolve — a member without decorators is the common case, and it must not pay for the
 * file's import list.
 */
export function classifyNestjsSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  ctx: FrameworkClassifyContext,
): SymbolClassification | null {
  if (symbol.kind !== "class" && symbol.kind !== "method") return null
  if (symbol.decorators.length === 0) return null

  const names = importedNamesFor(ctx)
  if (symbol.kind === "class") return classifyClass(symbol, names)
  return classifyMethod(symbol, names)
}

/**
 * The file's import index, built once per file rather than once per decorated Symbol.
 *
 * Every Symbol in a file resolves against the same edges, so rebuilding the index for each
 * one charges the file (declarations × import entries) to answer a question whose answer
 * cannot change — the shape `performance.md` §2 names as the corpus's blind spot, since a
 * single large file belongs to one shard and no amount of concurrency touches it.
 *
 * Keyed on the identity of the array the pipeline built for the file (`scan/pipeline.ts`
 * constructs one `FrameworkClassifyContext` per file and hands the classifier the same
 * `imports` reference for every candidate), so this is a memo of a pure function and not
 * plugin state: two files never collide, and an entry becomes collectable as soon as the
 * pipeline moves on. A caller that synthesizes a fresh array per call — a test, or a future
 * pipeline that stops sharing — gets the uncached path and the same answer.
 */
const importedNamesByFile = new WeakMap<readonly ImportEdge[], ImportedNames>()

function importedNamesFor(ctx: FrameworkClassifyContext): ImportedNames {
  const cached = importedNamesByFile.get(ctx.imports)
  if (cached !== undefined) return cached
  const names = readImportedNames(ctx.imports, ctx.file.path)
  importedNamesByFile.set(ctx.imports, names)
  return names
}

/**
 * Class classification is winner-take-all: if `@Module` / `@Controller` / `@Injectable`
 * / `@Catch` appears, that is the class's role. When more than one class-level decorator
 * is present (e.g. `@Controller @Injectable class MyThing {}`), the first one found in
 * decorator source order wins so results stay stable across re-runs.
 *
 * `decoratorBoundaries` gets a `true` entry for every recognized class-level decorator —
 * the framework cares about the shape as a whole, not just the "winning" one, so a
 * `@Controller` that also has `@Injectable` still surfaces both in the map. The map is
 * keyed on the written name, because that is the key the core matches it against when it
 * folds the boundary flags back onto `SymbolCandidate.decorators`.
 *
 * Confidence follows the winner alone: the extKind is a claim about the winning decorator,
 * so it is that decorator's provenance that decides how far the claim is trusted. A
 * recognized loser sitting under a foreign import still contributes its boundary flag.
 */
function classifyClass(
  symbol: SymbolCandidate<OpaqueAstNode>,
  names: ImportedNames,
): SymbolClassification | null {
  const boundaries: Record<string, true> = {}
  let winner: { extKind: string; role: string } | null = null
  let confidence: Confidence = "high"

  for (const decorator of symbol.decorators) {
    assertDecoratorName(decorator.name, symbol.id)
    const resolved = resolveDecoratorName(decorator.name, names)
    const hit = classifyClassDecorator(resolved.canonical)
    if (hit === undefined) continue
    boundaries[decorator.name] = true
    if (winner !== null) continue
    winner = hit
    confidence = resolved.confidence
  }
  if (winner === null) return null

  return {
    extKind: winner.extKind,
    decoratorBoundaries: boundaries,
    // Class derivedBy uses the semantic `role` (module / controller / provider / filter)
    // rather than the decorator identifier because NestJS renames the concept —
    // `@Injectable` semantically means "provider", and the derivedBy string carries that
    // meaning. Method derivedBy keeps the identifier (see classifyMethod) because HTTP verbs
    // and handler names have no equivalent semantic rewrite.
    derivedBy: `framework:nestjs:${winner.role}`,
    ...confidenceOverride(confidence),
  }
}

/**
 * Method classification promotes the method to `framework:nestjs:route` when it carries
 * an HTTP verb decorator or a pattern-style entry point. Handler-only decorators
 * (Guards / Interceptors / Pipes / Filters) mark the enclosing method as a boundary
 * without assigning the route extKind — a service method wrapped in a Guard is still a
 * boundary-worthy check, but it is not the route itself.
 *
 * `derivedBy` carries the decorator identifier (`Post`, `UseGuards`, `MessagePattern`, …)
 * where class classification carries a semantic role name; the asymmetry is deliberate (see
 * classifyClass). The identifier is the **imported** one, so a file that renamed `Get` to
 * `Fetch` on import still reports `framework:nestjs:route:Get`: `derivedBy` is a closed
 * vocabulary that downstream filters and diffs read, and it would otherwise change meaning
 * with a rename that changed nothing about the route. `Decorator.name` and `.raw` keep the
 * spelling the source used.
 *
 * Confidence follows the slot that decided the answer, the same rule classifyClass states:
 * a method carrying both a route decorator and a handler decorator reports the route's
 * provenance and discards the handler's, because the route is what the extKind claims. Both
 * still contribute their boundary flags.
 */
function classifyMethod(
  symbol: SymbolCandidate<OpaqueAstNode>,
  names: ImportedNames,
): SymbolClassification | null {
  const boundaries: Record<string, true> = {}
  let firstRoute: ResolvedWinner | null = null
  let firstHandler: ResolvedWinner | null = null

  for (const decorator of symbol.decorators) {
    const written = decorator.name
    assertDecoratorName(written, symbol.id)
    const { canonical, confidence } = resolveDecoratorName(written, names)
    if (!isMethodBoundaryDecorator(canonical)) continue
    boundaries[written] = true
    if (NESTJS_HTTP_METHOD_DECORATORS.has(canonical) || NESTJS_PATTERN_DECORATORS.has(canonical)) {
      firstRoute ??= { canonical, confidence }
    } else {
      firstHandler ??= { canonical, confidence }
    }
  }

  if (firstRoute !== null) {
    return {
      extKind: ROUTE_EXT_KIND,
      decoratorBoundaries: boundaries,
      derivedBy: `framework:nestjs:route:${firstRoute.canonical}`,
      ...confidenceOverride(firstRoute.confidence),
    }
  }
  if (firstHandler !== null) {
    return {
      decoratorBoundaries: boundaries,
      derivedBy: `framework:nestjs:handler:${firstHandler.canonical}`,
      ...confidenceOverride(firstHandler.confidence),
    }
  }
  return null
}

/** The decorator a branch settled on, paired with how far its provenance is trusted. */
interface ResolvedWinner {
  canonical: string
  confidence: Confidence
}

/**
 * Spread into a `SymbolClassification` to state a confidence below the default.
 *
 * `high` is emitted as the absence of the key rather than as the value, because
 * `SymbolClassification.confidence` documents an omitted key as meaning exactly that. A
 * classification that spelled it out would be equivalent to the core but would read, to
 * anyone comparing two results, as though something had been decided.
 */
function confidenceOverride(confidence: Confidence): { confidence?: Confidence } {
  return confidence === "high" ? {} : { confidence }
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
