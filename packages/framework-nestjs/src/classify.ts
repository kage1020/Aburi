import { CoreError } from "@aburi/core"
import type {
  Confidence,
  Decorator,
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
import { type ImportedBindings, readImportedNames, resolveDecoratorName } from "./imports"
import { NESTJS_DERIVED_BY_PREFIX } from "./manifest"

/** Shared by HTTP-verb and pattern-style handlers so one predicate finds every entry point. */
const ROUTE_EXT_KIND = "framework:nestjs:route"

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

const importedNamesByFile = new WeakMap<readonly ImportEdge[], ImportedBindings>()

function importedNamesFor(ctx: FrameworkClassifyContext): ImportedBindings {
  const cached = importedNamesByFile.get(ctx.imports)
  if (cached !== undefined) return cached
  const names = readImportedNames(ctx.imports, ctx.file.path)
  importedNamesByFile.set(ctx.imports, names)
  return names
}

function classifyClass(
  symbol: SymbolCandidate<OpaqueAstNode>,
  names: ImportedBindings,
): SymbolClassification | null {
  const boundaries: Record<string, true> = {}
  let winner: { extKind: string; role: string } | null = null
  let confidence: Confidence = "high"

  for (const decorator of symbol.decorators) {
    assertDecoratorName(decorator.name, symbol.id)
    assertDecoratorQualifier(decorator.qualifier, decorator.name, symbol.id)
    const resolved = resolveDecoratorName(decorator, names)
    const hit = classifyClassDecorator(resolved.canonical)
    if (hit === undefined) continue
    boundaries[boundaryKey(decorator)] = true
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

function classifyMethod(
  symbol: SymbolCandidate<OpaqueAstNode>,
  names: ImportedBindings,
): SymbolClassification | null {
  const boundaries: Record<string, true> = {}
  let firstRoute: ResolvedWinner | null = null
  let firstHandler: ResolvedWinner | null = null

  for (const decorator of symbol.decorators) {
    assertDecoratorName(decorator.name, symbol.id)
    assertDecoratorQualifier(decorator.qualifier, decorator.name, symbol.id)
    const { canonical, confidence } = resolveDecoratorName(decorator, names)
    if (!isMethodBoundaryDecorator(canonical)) continue
    boundaries[boundaryKey(decorator)] = true
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

interface ResolvedWinner {
  canonical: string
  confidence: Confidence
}

/** `high` is the documented meaning of an omitted `confidence`, so it is spread as nothing. */
function confidenceOverride(confidence: Confidence): { confidence?: Confidence } {
  return confidence === "high" ? {} : { confidence }
}

function boundaryKey(decorator: Decorator): string {
  const { qualifier } = decorator
  return qualifier === undefined ? decorator.name : `${qualifier}.${decorator.name}`
}

/** An empty decorator name is a language-plugin grammar regression; fail fast rather than let it fall through `Map.get("")`. */
function assertDecoratorName(name: string, symbolId: string): void {
  if (name.length > 0) return
  throw new CoreError(
    `Empty decorator name on Symbol "${symbolId}"; the upstream language plugin produced an unexpected grammar shape and this classifier refuses to silently skip it`,
    { code: "anonymous-symbol-id-attempted", value: symbolId },
  )
}

function assertDecoratorQualifier(
  qualifier: string | undefined,
  name: string,
  symbolId: string,
): void {
  if (qualifier === undefined) return
  if (qualifier.length > 0 && !qualifier.startsWith(".")) return
  throw new CoreError(
    `Decorator "${name}" on Symbol "${symbolId}" carries an unusable qualifier "${qualifier}"; the upstream language plugin produced an unexpected grammar shape and this classifier refuses to silently skip it`,
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
