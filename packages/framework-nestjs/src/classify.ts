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
import { NESTJS_DERIVED_BY_PREFIX } from "./manifest"

/** Shared by HTTP-verb and pattern-style handlers so one predicate finds every entry point. */
const ROUTE_EXT_KIND = "framework:nestjs:route"

/**
 * Classes look for `@Module` / `@Controller` / `@Injectable` / `@Catch`; methods for HTTP
 * verbs, pattern handlers and Guards / Interceptors / Pipes / Filters. `null` when nothing
 * matches, so a hollow classification never shadows another plugin (first-match-wins).
 * Tables are matched against the name a decorator was **imported** under (see `./imports`);
 * the import index is only built once a decorator needs resolving.
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
 * Per-file import index, memoized on the identity of the `imports` array the pipeline hands
 * every candidate of a file (`scan/pipeline.ts`). Rebuilding it per decorated Symbol would
 * charge a large single-shard file declarations × imports (`performance.md`). A fresh
 * array per call simply takes the uncached path.
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
 * The first class-level decorator in source order wins the role; every recognized one still
 * flags a boundary, keyed on the written name because that is what the core matches against
 * `SymbolCandidate.decorators`. Confidence follows the winner's provenance alone.
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
    // The semantic role, not the identifier: `@Injectable` means "provider".
    derivedBy: `${NESTJS_DERIVED_BY_PREFIX}:${winner.role}`,
    ...confidenceOverride(confidence),
  }
}

/**
 * An HTTP verb or pattern decorator makes the method a route; handler-only decorators
 * (Guards / Interceptors / Pipes / Filters) flag a boundary without the route extKind.
 * `derivedBy` carries the **imported** identifier (`Get`, not a local `Fetch` alias) so the
 * closed vocabulary downstream filters read does not change with a rename; `Decorator.name`
 * keeps the written spelling. Confidence follows the slot that decided the answer.
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
      derivedBy: `${NESTJS_DERIVED_BY_PREFIX}:route:${firstRoute.canonical}`,
      ...confidenceOverride(firstRoute.confidence),
    }
  }
  if (firstHandler !== null) {
    return {
      decoratorBoundaries: boundaries,
      derivedBy: `${NESTJS_DERIVED_BY_PREFIX}:handler:${firstHandler.canonical}`,
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

/** `high` is the documented meaning of an omitted `confidence`, so it is spread as nothing. */
function confidenceOverride(confidence: Confidence): { confidence?: Confidence } {
  return confidence === "high" ? {} : { confidence }
}

/** An empty decorator name is a language-plugin grammar regression; fail fast rather than let it fall through `Map.get("")`. */
function assertDecoratorName(name: string, symbolId: string): void {
  if (name.length > 0) return
  throw new CoreError(
    `Empty decorator name on Symbol "${symbolId}"; the upstream language plugin produced an unexpected grammar shape and this classifier refuses to silently skip it`,
    { code: "anonymous-symbol-id-attempted", value: symbolId },
  )
}

export {
  classifyClassDecorator,
  isMethodBoundaryDecorator,
  NESTJS_CLASS_DECORATORS,
  NESTJS_HANDLER_DECORATORS,
  NESTJS_HTTP_METHOD_DECORATORS,
  NESTJS_PATTERN_DECORATORS,
}
