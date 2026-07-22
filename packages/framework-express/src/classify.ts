import type {
  Confidence,
  ExtractionContext,
  OpaqueAstNode,
  SymbolCandidate,
  SymbolClassification,
} from "@aburi/types"
import { asSyntaxNode, calleeLeaf, calleeRoot, calleeText } from "./ast"
import type { ExpressExtKind } from "./ext-kinds"
import { EXPRESS_DERIVED_BY_PREFIX } from "./ext-kinds"
import { hasExpressImport } from "./imports"
import { analyzeUseArguments, EXPRESS_MIDDLEWARE_METHOD, type UseArgumentShape } from "./middleware"
import { extractRouterCall } from "./router"
import { isRouteMethod } from "./routes"

interface Result {
  extKind: ExpressExtKind
  derivedBy: string
  confidence: Confidence
}

/**
 * First-match-wins dispatcher. Only inspects symbols whose kind is one of the promoted
 * shapes (`const` for router instances, `call` for module-level chained-call registrations).
 * Everything else abstains with `null`.
 */
export function classifyExpressSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  ctx: ExtractionContext,
): SymbolClassification | null {
  const result = decide(symbol, ctx)
  if (result === null) return null
  return {
    extKind: result.extKind,
    derivedBy: result.derivedBy,
    confidence: result.confidence,
  }
}

function decide(symbol: SymbolCandidate<OpaqueAstNode>, ctx: ExtractionContext): Result | null {
  if (symbol.kind === "const") return classifyConstSymbol(symbol, ctx)
  if (symbol.kind === "call") return classifyCallSymbol(symbol, ctx)
  return null
}

function classifyConstSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  ctx: ExtractionContext,
): Result | null {
  const routerCall = extractRouterCall(symbol.fullNode)
  if (routerCall === null) return null
  // Router() as an identifier can come from anywhere; requiring an `express` import is the
  // difference between "definitely Express" (high) and "matches the pattern" (medium).
  const confidence: Confidence = hasExpressImport(ctx) ? "high" : "medium"
  return {
    extKind: "framework:express:router",
    derivedBy: `${EXPRESS_DERIVED_BY_PREFIX}:router:${routerCall.callee}`,
    confidence,
  }
}

function classifyCallSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  ctx: ExtractionContext,
): Result | null {
  const call = asSyntaxNode(symbol.fullNode)
  if (call === null) return null
  const callee = calleeText(call)
  if (callee === null) return null
  const method = calleeLeaf(callee)
  const receiver = calleeRoot(callee)
  const importAnchored = hasExpressImport(ctx)

  if (isRouteMethod(method)) {
    return {
      extKind: "framework:express:route",
      derivedBy: `${EXPRESS_DERIVED_BY_PREFIX}:route:${receiver}.${method}`,
      confidence: importAnchored ? "high" : "medium",
    }
  }

  if (method === EXPRESS_MIDDLEWARE_METHOD) {
    return classifyUseCall(callee, receiver, symbol, importAnchored)
  }

  return null
}

function classifyUseCall(
  callee: string,
  receiver: string,
  symbol: SymbolCandidate<OpaqueAstNode>,
  importAnchored: boolean,
): Result | null {
  const shape = analyzeUseArguments(symbol.fullNode)
  if (shape === null) return null

  // Priority within `.use(...)`:
  //   1. Error middleware — an arity-4 handler is unambiguous.
  //   2. Mount point — a `use(pathLiteral, identifier)` shape strongly suggests a
  //      sub-router mount, even when the identifier could theoretically be a plain
  //      middleware reference. Downgrades confidence when import-anchoring is missing.
  //   3. Middleware — everything else that fits the arity-3 or identifier shape.
  if (shape.hasErrorHandler) {
    return {
      extKind: "framework:express:error-middleware",
      derivedBy: `${EXPRESS_DERIVED_BY_PREFIX}:error-middleware:${callee};arity-4`,
      confidence: importAnchored ? "high" : "medium",
    }
  }

  if (isMountShape(shape)) {
    return {
      extKind: "framework:express:mount",
      derivedBy: `${EXPRESS_DERIVED_BY_PREFIX}:mount:${callee};router-identifier`,
      confidence: importAnchored ? "high" : "medium",
    }
  }

  if (shape.hasRegularHandler || shape.hasIdentifierArg) {
    const arity = shape.hasRegularHandler ? "arity-3" : "identifier-arg"
    // Identifier-arg middleware is inherently more ambiguous than an inline arity-3
    // arrow — cap it at medium even when an `express` import is present, so downstream
    // consumers can tell the two apart.
    const confidence: Confidence = shape.hasRegularHandler && importAnchored ? "high" : "medium"
    return {
      extKind: "framework:express:middleware",
      derivedBy: `${EXPRESS_DERIVED_BY_PREFIX}:middleware:${receiver}.use;${arity}`,
      confidence,
    }
  }

  return null
}

function isMountShape(shape: UseArgumentShape): boolean {
  // `app.use('/api', router)` — first is a path literal, second is a bare identifier, and
  // no handler-shaped argument was seen (otherwise error / middleware would have won).
  return (
    shape.argCount === 2 &&
    shape.firstArgIsPathLiteral &&
    shape.secondArgIsIdentifier &&
    !shape.hasRegularHandler &&
    !shape.hasErrorHandler
  )
}
