import { asSyntaxNode, calleeLeaf, calleeText } from "@aburi/core"
import type {
  Confidence,
  ExtractionContext,
  OpaqueAstNode,
  SymbolCandidate,
  SymbolClassification,
} from "@aburi/types"
import { calleeRoot } from "./callee"
import type { ExpressExtKind } from "./ext-kinds"
import { EXPRESS_DERIVED_BY_PREFIX } from "./ext-kinds"
import { hasExpressImport } from "./imports"
import { analyzeUseArguments, EXPRESS_MIDDLEWARE_METHOD, type UseArgumentShape } from "./middleware"
import { extractRouterCall } from "./router"
import { isRouteMethod } from "./routes"

/** `extKind` narrowed to the plugin's own union so a typo fails to compile. */
interface ExpressClassification {
  extKind: ExpressExtKind
  derivedBy: string
  confidence: Confidence
}

/**
 * First-match-wins over `const` symbols (router instances) and `call` symbols (module-level
 * chained-call registrations); every other kind abstains with `null`.
 */
export function classifyExpressSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  ctx: ExtractionContext,
): SymbolClassification | null {
  const result = classifyBySymbolKind(symbol, ctx)
  if (result === null) return null
  return {
    extKind: result.extKind,
    derivedBy: result.derivedBy,
    confidence: result.confidence,
  }
}

function classifyBySymbolKind(
  symbol: SymbolCandidate<OpaqueAstNode>,
  ctx: ExtractionContext,
): ExpressClassification | null {
  if (symbol.kind === "const") return classifyConstSymbol(symbol, ctx)
  if (symbol.kind === "call") return classifyCallSymbol(symbol, ctx)
  return null
}

function classifyConstSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  ctx: ExtractionContext,
): ExpressClassification | null {
  const routerCall = extractRouterCall(symbol.fullNode)
  if (routerCall === null) return null
  // An `express` import is what separates "definitely Express" (high) from "matches the pattern" (medium).
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
): ExpressClassification | null {
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
): ExpressClassification | null {
  const shape = analyzeUseArguments(symbol.fullNode)
  if (shape === null) return null

  // Priority: arity-4 error middleware (unambiguous) > `use(pathLiteral, identifier)` mount
  // > anything else fitting the arity-3 or identifier shape.
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
    // An identifier argument cannot be arity-checked here, so it is capped at medium.
    const confidence: Confidence = shape.hasRegularHandler && importAnchored ? "high" : "medium"
    return {
      extKind: "framework:express:middleware",
      derivedBy: `${EXPRESS_DERIVED_BY_PREFIX}:middleware:${receiver}.use;${arity}`,
      confidence,
    }
  }

  return null
}

/** `app.use('/api', router)`: a path literal, a bare identifier, and no handler-shaped argument. */
function isMountShape(shape: UseArgumentShape): boolean {
  return (
    shape.argCount === 2 &&
    shape.firstArgIsPathLiteral &&
    shape.secondArgIsIdentifier &&
    !shape.hasRegularHandler &&
    !shape.hasErrorHandler
  )
}
