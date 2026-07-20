import { lastQnameSegment } from "@aburi/core"
import type {
  ExtractionContext,
  OpaqueAstNode,
  SymbolCandidate,
  SymbolClassification,
} from "@aburi/types"
import { isPascalCase, matchesHocNaming, returnsContextProvider, returnsJsx } from "./components"
import { bodyCallsAnotherHook, matchesHookNaming } from "./hooks"
import { extractWrapperCall, isContextCall, isForwardRefCall, isMemoCall } from "./wrappers"

/**
 * Classify a SymbolCandidate against React conventions in first-match-wins order:
 *
 *   1. hook         — `function` kind, leaf name matches /^use[A-Z]/
 *   2. context      — `const` kind, initializer is `createContext(...)`
 *   3. forward-ref  — `const` kind, initializer is `forwardRef(...)`
 *   4. memo         — `const` kind, initializer is `memo(...)`
 *   5. provider     — `function` kind, PascalCase, body returns `<X.Provider>` JSX
 *   6. hoc          — `function` kind, leaf name matches /^with[A-Z]/
 *   7. component    — `function` kind, PascalCase, body returns JSX
 *
 * Order matters: a `useMy` hook that also returns JSX (rare but possible) classifies as
 * hook, not component. A `withFoo` HOC that returns JSX classifies as hoc, not component.
 * Any Symbol whose kind is not `function` or `const` returns `null` and flows through
 * unclassified.
 */
export function classifyReactSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
  _ctx: ExtractionContext,
): SymbolClassification | null {
  if (symbol.kind === "function") return classifyFunctionSymbol(symbol)
  if (symbol.kind === "const") return classifyConstSymbol(symbol)
  return null
}

function classifyFunctionSymbol(
  symbol: SymbolCandidate<OpaqueAstNode>,
): SymbolClassification | null {
  const leaf = lastQnameSegment(symbol.name)

  if (matchesHookNaming(leaf)) {
    const signals: string[] = ["framework:react:hook:naming"]
    if (bodyCallsAnotherHook(symbol.bodyNode)) {
      signals.push("framework:react:hook:hook-call")
    }
    return {
      extKind: "framework:react:hook",
      derivedBy: signals.join(";"),
    }
  }

  if (!isPascalCase(leaf)) {
    // Non-PascalCase, non-hook function is a plain utility — nothing React-specific to
    // classify. Leaves it unowned so no downstream tag pretends to know what it is.
    if (matchesHocNaming(leaf)) {
      // Belt-and-braces: `with*` is lowercase-first by construction, so this branch is
      // technically unreachable (the isPascalCase gate above only trips on uppercase),
      // but we keep the HOC classification here for symmetry with the naming table — if
      // isPascalCase ever loosens its rule, HOC still classifies via its own signal.
      return {
        extKind: "framework:react:hoc",
        derivedBy: "framework:react:hoc:naming",
      }
    }
    return null
  }

  // PascalCase function: could be a provider, an HOC (with* is lowercase so it does not
  // reach here in practice), or a plain component. Provider wins over component when the
  // returned JSX is a namespaced Provider element.
  if (returnsJsx(symbol.bodyNode) && returnsContextProvider(symbol.bodyNode)) {
    return {
      extKind: "framework:react:provider",
      derivedBy: "framework:react:provider",
    }
  }

  if (matchesHocNaming(leaf)) {
    return {
      extKind: "framework:react:hoc",
      derivedBy: "framework:react:hoc:naming",
    }
  }

  if (returnsJsx(symbol.bodyNode)) {
    return {
      extKind: "framework:react:component",
      derivedBy: "framework:react:component",
    }
  }

  return null
}

function classifyConstSymbol(symbol: SymbolCandidate<OpaqueAstNode>): SymbolClassification | null {
  const call = extractWrapperCall(symbol.fullNode)
  if (call === null) return null
  if (isContextCall(call)) {
    return {
      extKind: "framework:react:context",
      derivedBy: `framework:react:context:${call.callee}`,
    }
  }
  if (isForwardRefCall(call)) {
    return {
      extKind: "framework:react:forward-ref",
      derivedBy: `framework:react:forward-ref:${call.callee}`,
    }
  }
  if (isMemoCall(call)) {
    return {
      extKind: "framework:react:memo",
      derivedBy: `framework:react:memo:${call.callee}`,
    }
  }
  return null
}
